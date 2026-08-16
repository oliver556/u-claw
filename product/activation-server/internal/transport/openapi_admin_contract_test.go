package transport

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

type contractDocument map[string]any
type contractRoute struct {
	Method, Path      string
	Request, Response json.RawMessage
}

func TestOpenAPIAdminOperationsValidateTransportDTOFixture(t *testing.T) {
	doc, routes := loadAdminContract(t)
	if len(routes) != 9 {
		t.Fatalf("routes=%d", len(routes))
	}
	for _, route := range routes {
		requestSchema, responseSchema := operationContract(t, doc, route)
		if requestSchema == nil {
			if string(route.Request) != "null" {
				t.Fatal("body on bodyless route")
			}
		} else {
			validateDTO(t, doc, requestSchema, route.Request, requestDTO(route.Path))
		}
		validateDTO(t, doc, responseSchema, route.Response, responseDTO(route.Path))
	}
}

func TestOpenAPIAdminContractRejectsShapeDrift(t *testing.T) {
	doc, routes := loadAdminContract(t)
	mutation, _ := operationContract(t, doc, routes[3])
	_, summary := operationContract(t, doc, routes[2])
	_, audit := operationContract(t, doc, routes[8])
	assertSchemaError(t, doc, mutation, routes[2].Response)
	assertSchemaError(t, doc, summary, routes[3].Request)
	var auditPage struct{ Items json.RawMessage }
	_ = json.Unmarshal(routes[8].Response, &auditPage)
	assertSchemaError(t, doc, audit, auditPage.Items)
	var value map[string]any
	_ = json.Unmarshal(routes[3].Request, &value)
	value["extra"] = true
	extra, _ := json.Marshal(value)
	assertSchemaError(t, doc, mutation, extra)
	delete(value, "extra")
	delete(value, "operatorId")
	missing, _ := json.Marshal(value)
	assertSchemaError(t, doc, mutation, missing)
}

func loadAdminContract(t *testing.T) (contractDocument, []contractRoute) {
	t.Helper()
	openapi, _ := os.ReadFile(filepath.Join("..", "..", "api", "openapi.yaml"))
	var doc contractDocument
	if json.Unmarshal(openapi, &doc) != nil {
		t.Fatal("invalid openapi")
	}
	fixture, _ := os.ReadFile(filepath.Join("..", "..", "..", "shared", "tests", "fixtures", "admin-api-contract.json"))
	var wrapped struct{ Routes []contractRoute }
	if json.Unmarshal(fixture, &wrapped) != nil {
		t.Fatal("invalid fixture")
	}
	return doc, wrapped.Routes
}
func resolve(doc contractDocument, value any) map[string]any {
	object := value.(map[string]any)
	if ref, ok := object["$ref"].(string); ok {
		var node any = map[string]any(doc)
		for _, part := range splitRef(ref) {
			node = node.(map[string]any)[part]
		}
		return resolve(doc, node)
	}
	return object
}
func splitRef(ref string) []string {
	var out []string
	start := 2
	for i := 2; i <= len(ref); i++ {
		if i == len(ref) || ref[i] == '/' {
			out = append(out, ref[start:i])
			start = i + 1
		}
	}
	return out
}
func operationContract(t *testing.T, doc contractDocument, route contractRoute) (map[string]any, map[string]any) {
	t.Helper()
	paths := doc["paths"].(map[string]any)
	operation := resolve(doc, paths[route.Path].(map[string]any)[route.Method])
	var request map[string]any
	if body, ok := operation["requestBody"]; ok {
		request = resolve(doc, resolve(doc, body)["content"].(map[string]any)["application/json"].(map[string]any)["schema"])
	}
	code := "200"
	if route.Method == "post" && (route.Path == "/internal/v1/inventory" || route.Path == "/internal/v1/inventory/import") {
		code = "201"
	}
	response := resolve(doc, operation["responses"].(map[string]any)[code])
	schema := resolve(doc, response["content"].(map[string]any)["application/json"].(map[string]any)["schema"])
	return request, schema
}
func requestDTO(path string) any {
	switch path {
	case "/internal/v1/inventory":
		return &adminGenerateRequest{}
	case "/internal/v1/inventory/import":
		return &adminImportRequest{}
	case "/internal/v1/new-api-bindings/{deviceId}/balance-status":
		return &adminBalanceStatusRequest{}
	default:
		return &adminOperationRequest{}
	}
}
func responseDTO(path string) any {
	switch path {
	case "/internal/v1/inventory":
		return &inventorySecretResponse{}
	case "/internal/v1/licenses/{id}/reissue":
		return &reissueResponse{}
	case "/internal/v1/licenses/{id}/disable", "/internal/v1/licenses/{id}/enable", "/internal/v1/licenses/{id}/revoke":
		return &mutationResponse{}
	case "/internal/v1/audit":
		return &auditPageResponse{}
	default:
		return &inventorySummaryResponse{}
	}
}
func validateDTO(t *testing.T, doc contractDocument, schema map[string]any, raw json.RawMessage, dto any) {
	t.Helper()
	if schema["type"] == "array" {
		schema = resolve(doc, schema["items"])
		raw = []byte("[" + string(raw) + "]")
		var list []json.RawMessage
		if json.Unmarshal(raw, &list) != nil {
			t.Fatal("array marshal")
		}
		raw = list[0]
	}
	if json.Unmarshal(raw, dto) != nil {
		t.Fatal("DTO decode")
	}
	encoded, _ := json.Marshal(dto)
	var value any
	_ = json.Unmarshal(encoded, &value)
	if err := validateSchema(doc, schema, value); err != nil {
		t.Fatalf("schema: %v payload=%s", err, encoded)
	}
}
func assertSchemaError(t *testing.T, doc contractDocument, schema map[string]any, raw []byte) {
	t.Helper()
	var value any
	_ = json.Unmarshal(raw, &value)
	if validateSchema(doc, schema, value) == nil {
		t.Fatalf("invalid payload accepted: %s", raw)
	}
}
func validateSchema(doc contractDocument, schema map[string]any, value any) error {
	schema = resolve(doc, schema)
	if schema["type"] == "array" {
		items, ok := value.([]any)
		if !ok {
			return fmt.Errorf("want array")
		}
		for _, item := range items {
			if err := validateSchema(doc, resolve(doc, schema["items"]), item); err != nil {
				return err
			}
		}
		return nil
	}
	object, ok := value.(map[string]any)
	if !ok {
		return fmt.Errorf("want object")
	}
	props := schema["properties"].(map[string]any)
	for _, field := range schema["required"].([]any) {
		if _, ok := object[field.(string)]; !ok {
			return fmt.Errorf("missing %s", field)
		}
	}
	if schema["additionalProperties"] == false {
		for key := range object {
			if _, ok := props[key]; !ok {
				return fmt.Errorf("extra %s", key)
			}
		}
	}
	return nil
}
