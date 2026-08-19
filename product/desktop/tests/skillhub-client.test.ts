import { createHash } from "node:crypto";

import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";

import { parseSkillMarkdownFrontmatter, validateSkillBundle } from "../src/skills/bundle-validator.js";
import { createSkillHubClient } from "../src/skills/skillhub-client.js";
import { skillHubFailureReason } from "../src/skills/fixture-client.js";

const namespace = { canonicalName: "@owner/workspace-reader", displayName: "owner", handle: "owner", publicSlug: "workspace-reader" };
const searchItem = {
  slug: "workspace-reader", name: "Workspace Reader", description: "Reads workspace files", description_zh: null,
  version: "1.0.0", labels: { requires_api_key: "false", pricing_type: "free", category: "productivity" }, namespace,
  iconUrl: "https://cloudcache.tencent-cloud.com/qcloud/ui/static/workspace-reader.png",
};
const detailBody = {
  slug: "workspace-reader", namespace, latestVersion: { version: "1.0.0", changelog: null, createdAt: 1, updatedAt: "2026-08-19T12:00:00.000Z" },
  skill: {
    slug: "workspace-reader", displayName: "Workspace Reader", summary: "Reads workspace files", summary_zh: null,
    labels: { requires_api_key: "false", pricing_type: "free", category: "productivity" },
    upstream_owner_login: "upstream-owner", downloads: 879, stars: 4, requires_key: false,
    iconUrl: "https://skillhub-1388575217.cos.accelerate.myqcloud.com/skill-icons/workspace-reader.png",
  },
};
const skillMd = `---
slug: workspace-reader
name: Workspace Reader
description: "Reads workspace files"
version: 1.0.0
---

# Workspace Reader
`;
const canonicalSkillMd = `---
name: Workspace Reader
description: "Reads workspace files"
version: 1.0.0
license: MIT
---

# Workspace Reader
`;

const json = (value: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(value), {
  status: 200,
  headers: { "content-type": "application/json", ...init.headers },
  ...init,
});

const redirect = (path: string, host = "skillhub-1388575217.cos.accelerate.myqcloud.com") => new Response(null, {
  status: 302,
  headers: { location: `https://${host}/${path}` },
});

async function zipOf(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  zip.file("_meta.json", "{}");
  return zip.generateAsync({ type: "uint8array" });
}

const responseBody = (bytes: Uint8Array): ArrayBuffer => Uint8Array.from(bytes).buffer;

function filesBody(files: Record<string, string>) {
  return {
    count: Object.keys(files).length,
    files: Object.entries(files).map(([path, content]) => ({
      path, size: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex"),
    })),
    namespace,
    version: "1.0.0",
  };
}

function bundleOf(files: Record<string, string>) {
  const entries = Object.entries(files).map(([path, content]) => ({
    path,
    type: "file" as const,
    size: Buffer.byteLength(content),
    contentBase64: Buffer.from(content).toString("base64"),
  }));
  return {
    sourceUrl: "https://api.skillhub.cn/api/v1/download?slug=workspace-reader&version=1.0.0&namespace=owner",
    compressedBytes: 100,
    checksumSha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    entries,
  };
}

describe("live SkillHub client", () => {
  it("accepts canonical frontmatter without API-owned slug or version fields", () => {
    expect(parseSkillMarkdownFrontmatter(`---
name: Workspace Reader
description: Reads workspace files
---
`)).toEqual({ slug: undefined, name: "Workspace Reader", description: "Reads workspace files", version: undefined });
  });

  it("does not treat nested metadata fields as top-level Skill identity", () => {
    expect(parseSkillMarkdownFrontmatter(`---
name: free-tool-strategy
description: Plans free tools
metadata:
  version: 1.1.0
---
`)).toEqual({ slug: undefined, name: "free-tool-strategy", description: "Plans free tools", version: undefined });
  });

  it("folds YAML block scalars and ignores whitespace-only lines when detecting indentation", () => {
    expect(parseSkillMarkdownFrontmatter(`---
name: Folded Skill
description: >-
  first line

  second line
---
`).description).toBe("first line\nsecond line");
    expect(parseSkillMarkdownFrontmatter(`---
name: Literal Skill
description: |
${"    "}
  actual text
---
`).description).toBe("\nactual text\n");
  });

  it("maps the official free catalog contract with an exact credential-free request", async () => {
    const fetch = vi.fn(async () => json({ code: 0, data: { skills: [searchItem], total: 21 }, message: "success" }));
    const client = createSkillHubClient({ fetch });

    await expect(client.search({ query: "workspace & files", category: "productivity", cursor: "2", pageSize: 20 })).resolves.toMatchObject({
      items: [{ slug: "workspace-reader", pricingType: "free", risk: "high", mode: "live", categories: ["productivity"] }],
      nextCursor: null, hasMore: false, mode: "live",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.skillhub.cn/api/skills?page=2&pageSize=20&keyword=workspace+%26+files&category=productivity&labels=pricing_type%3A%21paid",
      { method: "GET", headers: { accept: "application/json" }, redirect: "error", signal: expect.any(AbortSignal) },
    );
    expect((await client.search({ query: "", cursor: null, pageSize: 20 })).items[0]?.logoUrl).toBe("https://cloudcache.tencent-cloud.com/qcloud/ui/static/workspace-reader.png");
  });

  it("keeps confirmed namespace identity on the internal client seam", async () => {
    const client = createSkillHubClient({ fetch: vi.fn(async () => json({
      code: 0, data: { skills: [searchItem], total: 1 }, message: "success",
    })) });

    const result = await client.search({ query: "workspace-reader", cursor: null, pageSize: 20 });

    expect(client.confirmedIdentity("workspace-reader")).toEqual({
      slug: "workspace-reader", namespace: "owner", version: "1.0.0",
    });
    expect(result.items[0]).not.toHaveProperty("namespace");
  });

  it("rejects detail when the selected catalog version is no longer current", async () => {
    const fetch = vi.fn(async (_url: string) => json({ code: 0, data: { skills: [searchItem], total: 1 }, message: "success" }));
    const client = createSkillHubClient({ fetch });
    await client.search({ query: "workspace-reader", cursor: null, pageSize: 20 });

    await expect(client.detail("workspace-reader", "2.0.0")).rejects.toThrow(/version/i);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("projects optional marketplace metadata and forwards the selected sort", async () => {
    const enriched = {
      ...searchItem,
      upstream_owner_login: "upstream-owner",
      downloads: 879,
      stars: 4,
      requires_key: true,
      updated_at: "2026-08-19T12:00:00.000Z",
    };
    const fetch = vi.fn(async (_url: string) => json({ code: 0, data: { skills: [enriched], total: 1 }, message: "success" }));
    const client = createSkillHubClient({ fetch });

    await expect(client.search({ query: "", cursor: null, pageSize: 40, sort: "stars" })).resolves.toMatchObject({
      items: [{ ownerName: "upstream-owner", downloads: 879, stars: 4, requiresKey: true, updatedAt: "2026-08-19T12:00:00.000Z" }],
    });
    expect(fetch.mock.calls[0]?.[0]).toContain("sortBy=stars&order=desc");
  });

  it.each([
    ["score", "score"],
    ["downloads", "downloads"],
    ["stars", "stars"],
    ["updatedAt", "updated_at"],
  ] as const)("maps the %s sort to SkillHub's %s field", async (sort, sortBy) => {
    const fetch = vi.fn(async (_url: string) => json({ code: 0, data: { skills: [searchItem], total: 1 }, message: "success" }));
    const client = createSkillHubClient({ fetch });

    await client.search({ query: "", cursor: null, pageSize: 20, sort });

    expect(fetch.mock.calls[0]?.[0]).toContain(`sortBy=${sortBy}&order=desc`);
    expect(fetch.mock.calls[0]?.[0]).not.toContain("sort=");
  });

  it("ignores malformed optional marketplace metadata instead of leaking loose upstream values", async () => {
    const malformed = {
      ...searchItem,
      labels: { pricing_type: "free" },
      ownerName: { unsafe: true }, downloads: -1, stars: 2.5, requires_key: "sometimes", updatedAt: "yesterday",
    };
    const client = createSkillHubClient({ fetch: vi.fn(async () => json({
      code: 0, data: { skills: [malformed], total: 1 }, message: "success",
    })) });

    const [item] = (await client.search({ query: "", cursor: null, pageSize: 20 })).items;
    expect(item).toMatchObject({ ownerName: "owner" });
    expect(item).not.toHaveProperty("downloads");
    expect(item).not.toHaveProperty("stars");
    expect(item).not.toHaveProperty("requiresKey");
    expect(item).not.toHaveProperty("updatedAt");
  });

  it.each([
    ["paid", { pricing_type: "paid" }],
    ["trial", { pricing_type: "trial" }],
  ])("fails closed for %s catalog pricing", async (_label, labels) => {
    const client = createSkillHubClient({ fetch: vi.fn(async () => json({
      code: 0, data: { skills: [{ ...searchItem, labels }], total: 1 }, message: "success",
    })) });
    await expect(client.search({ query: "", cursor: null, pageSize: 20 })).rejects.toThrow("free");
  });

  it("accepts the official not-paid catalog response and its direct category field", async () => {
    const liveItem = { ...searchItem, labels: { requires_api_key: "false" }, category: "content-creation" };
    const client = createSkillHubClient({ fetch: vi.fn(async () => json({
      code: 0, data: { skills: [liveItem], total: 1 }, message: "success",
    })) });
    await expect(client.search({ query: "", cursor: null, pageSize: 20 })).resolves.toMatchObject({
      items: [{ slug: "workspace-reader", pricingType: "free", categories: ["content-creation"] }],
    });
  });

  it("accepts pricing-free detail only after the official not-paid catalog confirmed the slug", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ code: 0, data: { skills: [{ ...searchItem, labels: null }], total: 1 }, message: "success" }))
      .mockResolvedValueOnce(json({ ...detailBody, skill: { ...detailBody.skill, labels: null, category: "productivity" } }))
      .mockResolvedValueOnce(redirect("signed/skill.md"))
      .mockResolvedValueOnce(new Response(canonicalSkillMd, { headers: { "content-type": "text/markdown" } }));
    const client = createSkillHubClient({ fetch });
    await client.search({ query: "", cursor: null, pageSize: 20 });
    await expect(client.detail("workspace-reader")).resolves.toMatchObject({ pricingType: "free", categories: ["productivity"] });
  });

  it.each([
    ["namespace", { namespace: { ...namespace, handle: "other-owner" } }],
    ["version", { latestVersion: { ...detailBody.latestVersion, version: "2.0.0" } }],
  ])("rejects pricing-free detail when the filtered %s identity drifts", async (_field, drift) => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ code: 0, data: { skills: [{ ...searchItem, labels: null }], total: 1 }, message: "success" }))
      .mockResolvedValueOnce(json({ ...detailBody, ...drift, skill: { ...detailBody.skill, labels: null } }));
    const client = createSkillHubClient({ fetch });
    await client.search({ query: "", cursor: null, pageSize: 20 });
    await expect(client.detail("workspace-reader")).rejects.toThrow(/identity|free/i);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("drops ambiguous duplicate slugs without rejecting safe catalog items", async () => {
    const safeItem = {
      ...searchItem,
      slug: "safe-skill",
      name: "Safe Skill",
      namespace: { ...namespace, canonicalName: "@owner/safe-skill", publicSlug: "safe-skill" },
    };
    const client = createSkillHubClient({ fetch: vi.fn(async () => json({
      code: 0,
      data: {
        skills: [searchItem, { ...searchItem, namespace: { ...namespace, handle: "other-owner" } }, safeItem],
        total: 3,
      },
      message: "success",
    })) });
    await expect(client.search({ query: "", cursor: null, pageSize: 20 })).resolves.toMatchObject({
      items: [{ slug: "safe-skill" }],
    });
    expect(client.confirmedIdentity("workspace-reader")).toBeUndefined();
  });

  it("keeps the first catalog identity when a later page reuses its slug", async () => {
    const conflictingItem = { ...searchItem, namespace: { ...namespace, handle: "other-owner" } };
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ code: 0, data: { skills: [searchItem], total: 40 }, message: "success" }))
      .mockResolvedValueOnce(json({ code: 0, data: { skills: [conflictingItem], total: 40 }, message: "success" }));
    const client = createSkillHubClient({ fetch });

    await client.search({ query: "", cursor: null, pageSize: 20 });
    await expect(client.search({ query: "", cursor: "2", pageSize: 20 })).resolves.toMatchObject({ items: [] });
    expect(client.confirmedIdentity("workspace-reader")).toEqual({
      slug: "workspace-reader", namespace: "owner", version: "1.0.0",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("accepts a newer version from the same namespace in a replacement catalog", async () => {
    const upgradedItem = { ...searchItem, version: "2.0.0" };
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ code: 0, data: { skills: [searchItem], total: 1 }, message: "success" }))
      .mockResolvedValueOnce(json({ code: 0, data: { skills: [upgradedItem], total: 1 }, message: "success" }));
    const client = createSkillHubClient({ fetch });

    await client.search({ query: "", cursor: null, pageSize: 20 });
    await expect(client.search({ query: "", category: "education", cursor: null, pageSize: 20 })).resolves.toMatchObject({
      items: [{ slug: "workspace-reader", version: "2.0.0" }],
    });
    expect(client.confirmedIdentity("workspace-reader")).toEqual({
      slug: "workspace-reader", namespace: "owner", version: "2.0.0",
    });
  });

  it("discards an old detail response after a replacement catalog wins", async () => {
    let resolveDetail!: (value: Response) => void;
    const upgradedItem = { ...searchItem, version: "2.0.0" };
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ code: 0, data: { skills: [searchItem], total: 1 }, message: "success" }))
      .mockImplementationOnce(async () => new Promise<Response>((resolve) => { resolveDetail = resolve; }))
      .mockResolvedValueOnce(json({ code: 0, data: { skills: [upgradedItem], total: 1 }, message: "success" }));
    const client = createSkillHubClient({ fetch });

    await client.search({ query: "", cursor: null, pageSize: 20 });
    const oldDetail = client.detail("workspace-reader", "1.0.0");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await client.search({ query: "", category: "education", cursor: null, pageSize: 20 });
    resolveDetail(json(detailBody));

    await expect(oldDetail).rejects.toThrow(/catalog changed/i);
    expect(client.confirmedIdentity("workspace-reader")).toEqual({
      slug: "workspace-reader", namespace: "owner", version: "2.0.0",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("fails closed when detail does not explicitly declare free pricing", async () => {
    const client = createSkillHubClient({ fetch: vi.fn(async () => json({
      ...detailBody, skill: { ...detailBody.skill, labels: { requires_api_key: "false" } },
    })) });
    await expect(client.detail("workspace-reader")).rejects.toThrow("free");
  });

  it("fails closed when pricing metadata conflicts", async () => {
    const client = createSkillHubClient({ fetch: vi.fn(async () => json({
      ...detailBody, skill: { ...detailBody.skill, billingType: "paid" },
    })) });
    await expect(client.detail("workspace-reader")).rejects.toThrow("free");
  });

  it.each([
    ["paid flag", { paid: "true", pricing_type: "free" }, {}],
    ["ambiguous paid flag", { paid: "yes", pricing_type: "free" }, {}],
    ["positive price", { pricing_type: "free", price: "9.99" }, {}],
    ["trial flag", { pricing_type: "free", trial: "true" }, {}],
    ["object amount", { pricing_type: "free" }, { pricing: { type: "free", amount: 1 } }],
    ["string object amount", { pricing_type: "free" }, { pricing: { type: "free", amount: "9.99" } }],
  ])("fails closed for %s even with a free label", async (_case, labels, extra) => {
    const client = createSkillHubClient({ fetch: vi.fn(async () => json({
      ...detailBody, skill: { ...detailBody.skill, labels, ...extra },
    })) });
    await expect(client.detail("workspace-reader")).rejects.toThrow("free");
  });

  it("accepts only explicit free values across optional pricing fields", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({
        ...detailBody,
        skill: {
          ...detailBody.skill,
          labels: { pricing_type: "free", paid: "false", price: "0", trial: "false" },
          paid: false,
          price: 0,
          trial: false,
          billingType: "free",
          pricing: { type: "free", amount: 0 },
        },
      }))
      .mockResolvedValueOnce(redirect("signed/skill.md"))
      .mockResolvedValueOnce(new Response(canonicalSkillMd, { headers: { "content-type": "text/markdown", "content-length": String(Buffer.byteLength(canonicalSkillMd)) } }));
    const client = createSkillHubClient({ fetch });
    await expect(client.detail("workspace-reader")).resolves.toMatchObject({ pricingType: "free" });
  });

  it("rejects paid metadata nested inside pricing plan objects", async () => {
    const client = createSkillHubClient({ fetch: vi.fn(async () => json({
      ...detailBody,
      skill: {
        ...detailBody.skill,
        pricing: { type: "free", plan: { amount: "9.99" } },
      },
    })) });
    await expect(client.detail("workspace-reader")).rejects.toThrow("free");
  });

  it("rejects excessively deep pricing metadata", async () => {
    let plan: Record<string, unknown> = { type: "free" };
    for (let depth = 0; depth < 20; depth += 1) plan = { type: "free", plan };
    const client = createSkillHubClient({ fetch: vi.fn(async () => json({
      ...detailBody,
      skill: { ...detailBody.skill, pricing: plan },
    })) });
    await expect(client.detail("workspace-reader")).rejects.toThrow("free");
  });

  it("rejects pricing metadata that exceeds the inspection node limit", async () => {
    const fields = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`field-${index}`, "free"]));
    const client = createSkillHubClient({ fetch: vi.fn(async () => json({
      ...detailBody,
      skill: { ...detailBody.skill, pricing: { type: "free", plan: fields } },
    })) });
    await expect(client.detail("workspace-reader")).rejects.toThrow("free");
  });

  it("rejects untrusted bases, API failures, malformed bodies, explicit paid labels, and oversized JSON", async () => {
    expect(() => createSkillHubClient({ baseUrl: "http://api.skillhub.cn" })).toThrow("trusted SkillHub HTTPS origin");
    expect(() => createSkillHubClient({ baseUrl: "https://example.com" })).toThrow("trusted SkillHub HTTPS origin");
    const responses = [
      json({ code: 9, data: { skills: [], total: 0 }, message: "failed" }),
      json({ code: 0, data: { skills: [{ ...searchItem, unknownRequiredShape: null }], total: "one" }, message: "success" }),
      json({ code: 0, data: { skills: [{ ...searchItem, labels: { pricing: "paid" } }], total: 1 }, message: "success" }),
      new Response("x", { headers: { "content-type": "application/json", "content-length": String(1024 * 1024 + 1) } }),
    ];
    const client = createSkillHubClient({ fetch: vi.fn(async () => responses.shift()!) });
    const input = { query: "", cursor: null, pageSize: 20 };

    await expect(client.search(input)).rejects.toThrow("SkillHub API request failed");
    await expect(client.search(input)).rejects.toThrow();
    await expect(client.search(input)).rejects.toThrow("explicitly free");
    await expect(client.search(input)).rejects.toThrow("response exceeds limit");
  });

  it("reads real SKILL.md frontmatter through a validated COS redirect", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json(detailBody))
      .mockResolvedValueOnce(redirect("signed/skill.md"))
      .mockResolvedValueOnce(new Response(canonicalSkillMd, { headers: { "content-type": "text/markdown", "content-length": String(Buffer.byteLength(canonicalSkillMd)) } }));
    const client = createSkillHubClient({ fetch });

    const result = await client.detail("workspace-reader");
    expect(result).toMatchObject({
      slug: "workspace-reader", name: "Workspace Reader", description: "Reads workspace files", version: "1.0.0",
      pricingType: "free", risk: "high", logoUrl: "https://skillhub-1388575217.cos.accelerate.myqcloud.com/skill-icons/workspace-reader.png", readme: canonicalSkillMd,
      ownerName: "upstream-owner", downloads: 879, stars: 4, requiresKey: false, updatedAt: "2026-08-19T12:00:00.000Z",
      identityFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      manifest: { kind: "skill", id: "workspace-reader", version: "1.0.0", entry: "SKILL.md" },
    });
    expect(result).not.toHaveProperty("namespace");
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://api.skillhub.cn/api/v1/skills/workspace-reader?namespace=",
      "https://api.skillhub.cn/api/v1/skills/workspace-reader/file?path=SKILL.md&version=1.0.0&namespace=owner",
      "https://skillhub-1388575217.cos.accelerate.myqcloud.com/signed/skill.md",
    ]);
  });

  it("uses SkillHub presentation fields while preserving the original SKILL.md", async () => {
    const localizedDetail = {
      ...detailBody,
      skill: {
        ...detailBody.skill,
        displayName: "工作区读取器",
        summary: "Reads workspace files",
        summary_zh: "读取工作区文件",
      },
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce(json(localizedDetail))
      .mockResolvedValueOnce(redirect("signed/skill.md"))
      .mockResolvedValueOnce(new Response(canonicalSkillMd, { headers: { "content-type": "text/markdown" } }));
    const client = createSkillHubClient({ fetch });

    await expect(client.detail("workspace-reader")).resolves.toMatchObject({
      name: "工作区读取器",
      description: "读取工作区文件",
      readme: canonicalSkillMd,
    });
  });

  it("falls back when SkillHub Chinese descriptions are blank", async () => {
    const blankChineseSearchItem = { ...searchItem, description_zh: "   " };
    const blankChineseDetail = {
      ...detailBody,
      skill: { ...detailBody.skill, summary_zh: "   " },
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ code: 0, data: { skills: [blankChineseSearchItem], total: 1 }, message: "success" }))
      .mockResolvedValueOnce(json(blankChineseDetail))
      .mockResolvedValueOnce(redirect("signed/skill.md"))
      .mockResolvedValueOnce(new Response(canonicalSkillMd, { headers: { "content-type": "text/markdown" } }));
    const client = createSkillHubClient({ fetch });

    await expect(client.search({ query: "", cursor: null, pageSize: 20 })).resolves.toMatchObject({
      items: [{ description: "Reads workspace files" }],
    });
    await expect(client.detail("workspace-reader")).resolves.toMatchObject({
      description: "Reads workspace files",
    });
  });

  it("truncates oversized upstream descriptions without rejecting the catalog page", async () => {
    const longDescription = "中".repeat(1_083);
    const client = createSkillHubClient({ fetch: vi.fn(async () => json({
      code: 0,
      data: { skills: [{ ...searchItem, description_zh: longDescription }], total: 1 },
      message: "success",
    })) });

    const [item] = (await client.search({ query: "", cursor: null, pageSize: 20 })).items;
    expect(item?.description).toBe("中".repeat(1_000));
  });

  it.each([
    "https://cloudcache.tencent-cloud.com.evil.example/tracker.png",
    "https://user:pass@cloudcache.tencent-cloud.com/tracker.png",
    "http://cloudcache.tencent-cloud.com/tracker.png",
  ])("drops untrusted marketplace logo URL %s from search and detail responses", async (untrusted) => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ code: 0, data: { skills: [{ ...searchItem, iconUrl: untrusted }], total: 1 }, message: "success" }))
      .mockResolvedValueOnce(json({ ...detailBody, skill: { ...detailBody.skill, iconUrl: untrusted } }))
      .mockResolvedValueOnce(redirect("signed/skill.md"))
      .mockResolvedValueOnce(new Response(canonicalSkillMd, { headers: { "content-type": "text/markdown" } }));
    const client = createSkillHubClient({ fetch });

    await expect(client.search({ query: "", cursor: null, pageSize: 20 })).resolves.toMatchObject({ items: [{ logoUrl: null }] });
    await expect(client.detail("workspace-reader")).resolves.toMatchObject({ logoUrl: null });
  });

  it("uses API identity for display when optional SKILL.md identity fields are stale", async () => {
    for (const markdown of [
      skillMd.replace("slug: workspace-reader", "slug: other-skill"),
      skillMd.replace("version: 1.0.0", "version: 2.0.0"),
    ]) {
      const client = createSkillHubClient({ fetch: vi.fn()
        .mockResolvedValueOnce(json(detailBody))
        .mockResolvedValueOnce(redirect("signed/skill.md"))
        .mockResolvedValueOnce(new Response(markdown, { headers: { "content-type": "text/markdown" } })) });
      await expect(client.detail("workspace-reader")).resolves.toMatchObject({
        slug: "workspace-reader",
        version: "1.0.0",
        name: "Workspace Reader",
        readme: markdown,
      });
    }
  });

  it("accepts a YAML block-scalar description for detail display and bundle validation", async () => {
    const markdown = `---\nname: ima-skill\ndescription: |\n  第一行说明。\n  第二行说明。\nhomepage: https://ima.qq.com\n---\n# IMA\n`;
    const client = createSkillHubClient({ fetch: vi.fn()
      .mockResolvedValueOnce(json(detailBody))
      .mockResolvedValueOnce(redirect("signed/skill.md"))
      .mockResolvedValueOnce(new Response(markdown, { headers: { "content-type": "text/markdown" } })) });

    await expect(client.detail("workspace-reader")).resolves.toMatchObject({ readme: markdown });
    expect(validateSkillBundle(bundleOf({ "SKILL.md": markdown }), {
      slug: "workspace-reader",
      version: "1.0.0",
      permissionFingerprint: "unused-for-markdown-bundles",
    }).manifest).toMatchObject({ id: "workspace-reader", version: "1.0.0" });
    expect(parseSkillMarkdownFrontmatter(markdown).description).toBe("第一行说明。\n第二行说明。\n");
  });

  it("distinguishes a missing detail record from a missing README payload", async () => {
    const missingDetail = createSkillHubClient({ fetch: vi.fn(async () => new Response(null, { status: 404 })) });
    await expect(missingDetail.detail("workspace-reader")).rejects.toSatisfy((error: unknown) => skillHubFailureReason(error) === "not-found");

    const missingReadme = createSkillHubClient({ fetch: vi.fn()
      .mockResolvedValueOnce(json(detailBody))
      .mockResolvedValueOnce(redirect("signed/skill.md"))
      .mockResolvedValueOnce(new Response(null, { status: 404 })) });
    await expect(missingReadme.detail("workspace-reader")).rejects.toSatisfy((error: unknown) => skillHubFailureReason(error) === "upstream-invalid");
  });

  it.each([429, 503])("classifies README redirect HTTP %s as transient upstream failure", async (status) => {
    const client = createSkillHubClient({ fetch: vi.fn()
      .mockResolvedValueOnce(json(detailBody))
      .mockResolvedValueOnce(new Response(null, { status })) });

    await expect(client.detail("workspace-reader")).rejects.toSatisfy(
      (error: unknown) => skillHubFailureReason(error) === "upstream-unavailable",
    );
  });

  it("classifies an invalid search response so identity refresh cannot use stale detail", async () => {
    const client = createSkillHubClient({ fetch: vi.fn(async () => json({ invalid: true })) });

    await expect(client.search({ query: "", cursor: null, pageSize: 20 })).rejects.toSatisfy(
      (error: unknown) => skillHubFailureReason(error) === "upstream-invalid",
    );
  });

  it("omits malformed search records without hiding valid siblings", async () => {
    const malformed = { ...searchItem, slug: "broken-skill", namespace: null };
    const client = createSkillHubClient({ fetch: vi.fn(async () => json({
      code: 0,
      data: { skills: [searchItem, malformed], total: 2 },
      message: "success",
    })) });

    await expect(client.search({ query: "workspace", cursor: null, pageSize: 20 })).resolves.toMatchObject({
      items: [{ slug: "workspace-reader", version: "1.0.0" }],
    });
  });

  it("rejects a non-empty search page when every record is malformed", async () => {
    const malformed = { ...searchItem, namespace: null };
    const client = createSkillHubClient({ fetch: vi.fn(async () => json({
      code: 0,
      data: { skills: [malformed], total: 1 },
      message: "success",
    })) });

    await expect(client.search({ query: "workspace", cursor: null, pageSize: 20 })).rejects.toSatisfy(
      (error: unknown) => skillHubFailureReason(error) === "upstream-invalid",
    );
  });

  it.each([
    ["slug", skillMd.replace("slug: workspace-reader", "slug: other-skill")],
    ["version", skillMd.replace("version: 1.0.0", "version: 2.0.0")],
  ])("still rejects a downloaded bundle whose SKILL.md %s conflicts with the confirmed API identity", (_field, markdown) => {
    expect(() => validateSkillBundle(bundleOf({ "SKILL.md": markdown }), {
      slug: "workspace-reader",
      version: "1.0.0",
      permissionFingerprint: "unused-for-markdown-bundles",
    })).toThrow("manifest does not match request");
  });

  it("rejects redirects to any host outside the fixed HTTPS COS boundary", async () => {
    const client = createSkillHubClient({ fetch: vi.fn()
      .mockResolvedValueOnce(json(detailBody))
      .mockResolvedValueOnce(redirect("signed/skill.md", "evil.example.com")) });
    await expect(client.detail("workspace-reader")).rejects.toThrow("untrusted redirect");
  });

  it("rejects redirected payloads with the wrong media type", async () => {
    const client = createSkillHubClient({ fetch: vi.fn()
      .mockResolvedValueOnce(json(detailBody))
      .mockResolvedValueOnce(redirect("signed/skill.md"))
      .mockResolvedValueOnce(json({ markdown: skillMd })) });
    await expect(client.detail("workspace-reader")).rejects.toThrow("content type");
  });

  it("rejects detail billing metadata even when the catalog filter is bypassed", async () => {
    const client = createSkillHubClient({ fetch: vi.fn(async () => json({
      ...detailBody,
      skill: { ...detailBody.skill, labels: { requires_api_key: "false" }, billingType: "per_call" },
    })) });
    await expect(client.detail("workspace-reader")).rejects.toThrow("explicitly free");
  });

  it("downloads the real ZIP through a trusted redirect and verifies its listed files", async () => {
    const files = { "SKILL.md": canonicalSkillMd, "manifest.yaml": "name: Workspace Reader\n" };
    const archive = await zipOf(files);
    const fetch = vi.fn()
      .mockResolvedValueOnce(json(detailBody))
      .mockResolvedValueOnce(redirect("signed/skill.md"))
      .mockResolvedValueOnce(new Response(canonicalSkillMd, { headers: { "content-type": "text/markdown" } }))
      .mockResolvedValueOnce(json(filesBody(files)))
      .mockResolvedValueOnce(redirect("signed/skill.zip"))
      .mockResolvedValueOnce(new Response(responseBody(archive), { headers: { "content-type": "application/zip", "content-length": String(archive.byteLength) } }));
    const client = createSkillHubClient({ fetch });
    const expected = await client.detail("workspace-reader");
    const bundle = await client.download("workspace-reader");

    expect(validateSkillBundle(bundle, expected).manifest).toMatchObject({ id: "workspace-reader", version: "1.0.0", entry: "SKILL.md" });
    expect(bundle.entries.map((entry) => entry.path)).toEqual(["SKILL.md", "manifest.yaml"]);
  });

  it("accepts safe explicit directory entries while projecting only listed files", async () => {
    const files = { "SKILL.md": canonicalSkillMd, "docs/readme.md": "# Notes\n" };
    const zip = new JSZip();
    zip.file("SKILL.md", canonicalSkillMd);
    zip.folder("docs")!.file("readme.md", "# Notes\n");
    const archive = await zip.generateAsync({ type: "uint8array" });
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ code: 0, data: { skills: [searchItem], total: 1 }, message: "success" }))
      .mockResolvedValueOnce(json(filesBody(files)))
      .mockResolvedValueOnce(redirect("signed/directories.zip"))
      .mockResolvedValueOnce(new Response(responseBody(archive), { headers: { "content-type": "application/zip" } }));
    const client = createSkillHubClient({ fetch });
    await client.search({ query: "workspace", cursor: null, pageSize: 20 });

    await expect(client.download("workspace-reader")).resolves.toMatchObject({
      entries: [
        { path: "SKILL.md", type: "file" },
        { path: "docs/readme.md", type: "file" },
      ],
    });
  });

  it("rejects download listing identity drift from confirmed catalog metadata", async () => {
    const files = { "SKILL.md": canonicalSkillMd };
    const archive = await zipOf(files);
    for (const drift of [
      { version: "2.0.0" },
      { namespace: { ...namespace, handle: "other-owner" } },
    ]) {
      const fetch = vi.fn()
        .mockResolvedValueOnce(json({ code: 0, data: { skills: [searchItem], total: 1 }, message: "success" }))
        .mockResolvedValueOnce(json({ ...filesBody(files), ...drift }))
        .mockResolvedValueOnce(redirect("signed/drift.zip"))
        .mockResolvedValueOnce(new Response(responseBody(archive), { headers: { "content-type": "application/zip" } }));
      const client = createSkillHubClient({ fetch });
      await client.search({ query: "workspace", cursor: null, pageSize: 20 });

      await expect(client.download("workspace-reader")).rejects.toThrow("identity mismatch");
    }
  });

  it.each([
    ["case collision", { "SKILL.md": canonicalSkillMd, "skill.md": "shadow" }, "duplicate paths"],
    ["Windows device", { "SKILL.md": canonicalSkillMd, "CON.txt": "device" }, "unsafe path"],
    ["Windows extended device", { "SKILL.md": canonicalSkillMd, "CONIN$.txt": "device" }, "unsafe path"],
    ["Windows superscript device", { "SKILL.md": canonicalSkillMd, "COM\u00b9.txt": "device" }, "unsafe path"],
    ["Windows spaced device", { "SKILL.md": canonicalSkillMd, "CON .txt": "device" }, "unsafe path"],
    ["Windows ADS", { "SKILL.md": canonicalSkillMd, "notes.txt:secret": "ads" }, "unsafe path"],
    ["Windows invalid character", { "SKILL.md": canonicalSkillMd, "bad?.txt": "invalid" }, "unsafe path"],
    ["Windows control character", { "SKILL.md": canonicalSkillMd, "bad\u001f.txt": "invalid" }, "unsafe path"],
    ["Windows trailing dot", { "SKILL.md": canonicalSkillMd, "notes.": "shadow" }, "unsafe path"],
    ["file ancestor", { "SKILL.md": canonicalSkillMd, docs: "file", "docs/readme.md": "child" }, "file/directory conflicts"],
  ])("rejects %s in the SkillHub file listing", async (_case, files, message) => {
    const client = createSkillHubClient({ fetch: vi.fn()
      .mockResolvedValueOnce(json({ code: 0, data: { skills: [searchItem], total: 1 }, message: "success" }))
      .mockResolvedValueOnce(json(filesBody(files))) });
    await client.search({ query: "workspace", cursor: null, pageSize: 20 });

    await expect(client.download("workspace-reader")).rejects.toThrow(message);
  });

  it("rejects case-equivalent file/directory conflicts inside the ZIP", async () => {
    const files = { "SKILL.md": canonicalSkillMd };
    const zip = new JSZip();
    zip.file("SKILL.md", canonicalSkillMd);
    zip.folder("skill.md");
    const archive = await zip.generateAsync({ type: "uint8array" });
    const client = createSkillHubClient({ fetch: vi.fn()
      .mockResolvedValueOnce(json({ code: 0, data: { skills: [searchItem], total: 1 }, message: "success" }))
      .mockResolvedValueOnce(json(filesBody(files)))
      .mockResolvedValueOnce(redirect("signed/collision.zip"))
      .mockResolvedValueOnce(new Response(responseBody(archive), { headers: { "content-type": "application/zip" } })) });
    await client.search({ query: "workspace", cursor: null, pageSize: 20 });

    await expect(client.download("workspace-reader")).rejects.toThrow("file/directory conflicts");
  });

  it.each([
    ["case collision", { "SKILL.md": canonicalSkillMd, "skill.md": "shadow" }, "duplicate paths"],
    ["Windows device", { "SKILL.md": canonicalSkillMd, "AUX/readme.md": "device" }, "escapes target"],
    ["Windows extended device", { "SKILL.md": canonicalSkillMd, "CONOUT$.txt": "device" }, "escapes target"],
    ["Windows superscript device", { "SKILL.md": canonicalSkillMd, "LPT\u00b2.txt": "device" }, "escapes target"],
    ["Windows spaced device", { "SKILL.md": canonicalSkillMd, "CONOUT$ .txt": "device" }, "escapes target"],
    ["Windows ADS", { "SKILL.md": canonicalSkillMd, "notes.txt:secret": "ads" }, "escapes target"],
    ["Windows invalid character", { "SKILL.md": canonicalSkillMd, "bad*.txt": "invalid" }, "escapes target"],
    ["Windows control character", { "SKILL.md": canonicalSkillMd, "bad\u007f.txt": "invalid" }, "escapes target"],
    ["Windows trailing space", { "SKILL.md": canonicalSkillMd, "notes ": "shadow" }, "escapes target"],
    ["file ancestor", { "SKILL.md": canonicalSkillMd, docs: "file", "docs/readme.md": "child" }, "file/directory conflicts"],
  ])("rejects %s in the final Skill bundle", (_case, files, message) => {
    expect(() => validateSkillBundle(bundleOf(files), {
      slug: "workspace-reader",
      version: "1.0.0",
      permissionFingerprint: "unused-for-markdown-bundles",
    })).toThrow(message);
  });

  it("rejects malformed file manifests, dangerous ZIP paths, hash mismatches, and oversized archives", async () => {
    const validFiles = { "SKILL.md": skillMd };
    const badPathArchive = await zipOf({ "../outside.txt": "x", "SKILL.md": skillMd });
    const hashMismatchArchive = await zipOf(validFiles);
    const responses = [
      json({ code: 0, data: { skills: [searchItem], total: 1 }, message: "success" }),
      json({ ...filesBody(validFiles), count: 2 }),
      json(filesBody(validFiles)), redirect("signed/path.zip"), new Response(responseBody(badPathArchive), { headers: { "content-type": "application/zip" } }),
      json({ ...filesBody(validFiles), files: [{ ...filesBody(validFiles).files[0], sha256: "0".repeat(64) }] }), redirect("signed/hash.zip"), new Response(responseBody(hashMismatchArchive), { headers: { "content-type": "application/zip" } }),
      json(filesBody(validFiles)), redirect("signed/large.zip"), new Response("x", { headers: { "content-type": "application/zip", "content-length": String(20 * 1024 * 1024 + 1) } }),
    ];
    const client = createSkillHubClient({ fetch: vi.fn(async () => responses.shift()!) });
    await client.search({ query: "workspace", cursor: null, pageSize: 20 });

    await expect(client.download("workspace-reader")).rejects.toThrow();
    await expect(client.download("workspace-reader")).rejects.toThrow("unsafe path");
    await expect(client.download("workspace-reader")).rejects.toThrow("hash mismatch");
    await expect(client.download("workspace-reader")).rejects.toThrow("response exceeds limit");
  });

  it("rejects ZIP symlinks before projecting archive entries as files", async () => {
    const zip = new JSZip();
    zip.file("SKILL.md", skillMd);
    zip.file("link", "outside", { unixPermissions: 0o120777 });
    const archive = await zip.generateAsync({ type: "uint8array", platform: "UNIX" });
    const files = { "SKILL.md": skillMd, link: "outside" };
    const client = createSkillHubClient({ fetch: vi.fn()
      .mockResolvedValueOnce(json({ code: 0, data: { skills: [searchItem], total: 1 }, message: "success" }))
      .mockResolvedValueOnce(json(filesBody(files)))
      .mockResolvedValueOnce(redirect("signed/link.zip"))
      .mockResolvedValueOnce(new Response(responseBody(archive), { headers: { "content-type": "application/zip" } })) });
    await client.search({ query: "workspace", cursor: null, pageSize: 20 });
    await expect(client.download("workspace-reader")).rejects.toThrow("unsafe ZIP entry");
  });

  it("rejects a ZIP with too many empty directory entries", async () => {
    const files = { "SKILL.md": canonicalSkillMd };
    const zip = new JSZip();
    zip.file("SKILL.md", canonicalSkillMd);
    for (let index = 0; index < 1_001; index += 1) zip.folder(`empty-${index}`);
    const archive = await zip.generateAsync({ type: "uint8array" });
    const client = createSkillHubClient({ fetch: vi.fn()
      .mockResolvedValueOnce(json({ code: 0, data: { skills: [searchItem], total: 1 }, message: "success" }))
      .mockResolvedValueOnce(json(filesBody(files)))
      .mockResolvedValueOnce(redirect("signed/directories-bomb.zip"))
      .mockResolvedValueOnce(new Response(responseBody(archive), { headers: { "content-type": "application/zip" } })) });
    await client.search({ query: "workspace", cursor: null, pageSize: 20 });
    await expect(client.download("workspace-reader")).rejects.toThrow("entry count");
  });
});
