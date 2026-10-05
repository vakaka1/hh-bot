import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

// Кнопка копирования для блоков кода
function CodeBlock({
  language,
  children,
}: {
  language: string;
  children: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);

  function copy() {
    const text =
      (children as { props?: { children?: unknown } })?.props?.children;
    const str = Array.isArray(text) ? text.join("") : String(text ?? "");
    navigator.clipboard.writeText(str).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{language || "код"}</span>
        <button type="button" className="code-copy" onClick={copy}>
          {copied ? "Скопировано" : "Копировать"}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

// Полноценный markdown: GFM-таблицы, подсветка кода, ссылки
const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{
          pre: ({ children }) => {
            // язык берём из className кода внутри pre
            const child = children as { props?: { className?: string } };
            const cls = child?.props?.className || "";
            const lang = /language-(\S+)/.exec(cls)?.[1] || "";
            return <CodeBlock language={lang}>{children}</CodeBlock>;
          },
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="table-wrap">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

export default Markdown;
