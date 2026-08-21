package releaseauth

import (
	"bytes"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"os/exec"
	"testing"
	"time"
)

func TestReleaseGateAndServerSigningPayloadContract(t *testing.T) {
	proof := fixtureAuthorization(time.Date(2026, 8, 21, 1, 5, 0, 0, time.UTC))
	privateKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, ed25519.SeedSize))
	privateKeyDER, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(map[string]any{"proof": proof, "privateKeyDER": base64.StdEncoding.EncodeToString(privateKeyDER)})
	if err != nil {
		t.Fatal(err)
	}
	script := `import { createPrivateKey, sign } from "node:crypto";
import { pointerSwitchAuthorizationSigningPayload } from "../../../packaging/release-authorization.mjs";
let input=""; for await (const chunk of process.stdin) input += chunk;
const value=JSON.parse(input); const payload=pointerSwitchAuthorizationSigningPayload(value.proof);
const key=createPrivateKey({key:Buffer.from(value.privateKeyDER,"base64"),format:"der",type:"pkcs8"});
process.stdout.write(JSON.stringify({payload:payload.toString("base64"),signature:sign(null,payload,key).toString("base64")}));`
	command := exec.Command("node", "--input-type=module", "-e", script)
	command.Stdin = bytes.NewReader(encoded)
	output, err := command.Output()
	if err != nil {
		t.Fatalf("Node release authorization contract failed: %v", err)
	}
	var got struct{ Payload, Signature string }
	if err := json.Unmarshal(output, &got); err != nil {
		t.Fatal(err)
	}
	wantPayload := SigningPayload(proof)
	if got.Payload != base64.StdEncoding.EncodeToString(wantPayload) {
		t.Fatal("release gate and server signing payloads differ")
	}
	signature, err := base64.StdEncoding.DecodeString(got.Signature)
	if err != nil || !ed25519.Verify(privateKey.Public().(ed25519.PublicKey), wantPayload, signature) {
		t.Fatal("release gate signature is not verifiable by server contract")
	}
}
