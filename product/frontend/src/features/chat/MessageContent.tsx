import type { ContentBlock } from "@uclaw/shared";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

function safeExternalUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function MarkdownText({ text }: { text: string }) {
  return <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    rehypePlugins={[rehypeSanitize]}
    components={{
      a({ href, children }) {
        const safeHref = safeExternalUrl(href ?? "");
        return safeHref === undefined ? <span>{children}</span> : <a href={safeHref} target="_blank" rel="noreferrer noopener">{children}</a>;
      },
    }}
  >{text}</ReactMarkdown>;
}

export function MessageContent({ blocks }: { blocks: ContentBlock[] }) {
  return <div className="message-content">{blocks.map((block) => {
    switch (block.type) {
      case "text": return block.format === "markdown" ? <MarkdownText key={block.id} text={block.text} /> : <p key={block.id}>{block.text}</p>;
      case "code": return <pre key={block.id}><code>{block.code}</code></pre>;
      case "notice": return <p key={block.id} className={`notice ${block.level}`}>{block.text}</p>;
      case "citation": return <p key={block.id}><strong>{block.label}</strong>{block.excerpt === undefined ? null : `：${block.excerpt}`}</p>;
      case "file": return <p key={block.id}>文件：{block.file.name}</p>;
      case "image": return <p key={block.id}>图片：{block.alt ?? block.file.name}</p>;
      case "tool-call": return <p key={block.id}>工具调用：{block.toolCallId}</p>;
      case "unsupported": return <p key={block.id} className="notice warning">{block.summary}</p>;
    }
  })}</div>;
}
