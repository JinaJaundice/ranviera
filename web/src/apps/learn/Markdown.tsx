// The Markdown of a lesson: GFM tables, maths through remark-math and rehype-katex with trust off, and Mermaid. Raw HTML is
// not rendered. Text that a model wrote in a tool call is repaired for display first (see markdown.ts).
import { Children, isValidElement, memo, useMemo, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { prepareMarkdown } from "./mathText";
import { MermaidBlock } from "./MermaidBlock";

export type MarkdownSize = "lead" | "ui" | "body";

const SIZE: Record<MarkdownSize, string> = { lead: "text-lead", ui: "text-ui", body: "text-body" };

const KATEX_OPTIONS = { throwOnError: false, trust: false, strict: "ignore" } as const;

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

function buildComponents(streaming: boolean): Components {
  return {
    p: ({ children }) => <p className="mb-4 last:mb-0">{children}</p>,
    h1: ({ children }) => <h3 className="mb-2 mt-5 text-title font-medium text-ink first:mt-0">{children}</h3>,
    h2: ({ children }) => <h4 className="mb-2 mt-4 text-lead font-medium text-ink first:mt-0">{children}</h4>,
    h3: ({ children }) => <h5 className="mb-1 mt-3 text-lead font-medium text-ink first:mt-0">{children}</h5>,
    h4: ({ children }) => <h6 className="mb-1 mt-3 text-lead font-medium text-ink-soft first:mt-0">{children}</h6>,
    ul: ({ children }) => <ul className="mb-4 list-disc space-y-1 pl-6 last:mb-0">{children}</ul>,
    ol: ({ children }) => <ol className="mb-4 list-decimal space-y-1 pl-6 last:mb-0">{children}</ol>,
    li: ({ children }) => <li className="min-w-0 pl-1">{children}</li>,
    strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
    em: ({ children }) => <em>{children}</em>,
    hr: () => <hr className="my-5 border-rule" />,
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noopener noreferrer" className="break-words text-signal underline underline-offset-2">
        {children}
      </a>
    ),
    img: ({ alt }) => <span className="text-ink-faint">{alt ? `Image: ${alt}` : "Image"}</span>,
    blockquote: ({ children }) => <blockquote className="mb-4 border-l-2 border-rule-strong pl-3 text-ink-soft last:mb-0">{children}</blockquote>,
    table: ({ children }) => (
      <div className="mb-4 max-w-full overflow-x-auto last:mb-0">
        <table className="w-max min-w-0 border-collapse text-body">{children}</table>
      </div>
    ),
    th: ({ children }) => <th className="border-b border-rule-strong px-3 py-1.5 text-left font-medium text-ink">{children}</th>,
    td: ({ children }) => <td className="border-b border-rule px-3 py-1.5 align-top">{children}</td>,
    // a fence arrives as pre > code, so the pre decides between a diagram and a block of code
    pre: ({ children }) => {
      const child = Children.toArray(children)[0] as ReactElement<{ className?: string; children?: ReactNode }> | undefined;
      const source = textOf(child?.props?.children).replace(/\n$/, "");
      if (/language-mermaid/.test(child?.props?.className ?? "")) return <MermaidBlock chart={source} streaming={streaming} />;
      return (
        <pre className="mb-4 max-w-full overflow-x-auto rounded-md border border-rule bg-sunken p-3 font-mono text-small text-ink last:mb-0">
          <code>{source}</code>
        </pre>
      );
    },
    code: ({ children }) => <code className="rounded-sm border border-rule bg-sunken px-1 font-mono text-small text-ink">{children}</code>,
  };
}

interface Props {
  children: string;
  /** text that a model wrote in a tool call is repaired for display first */
  fromTool?: boolean;
  size?: MarkdownSize;
  streaming?: boolean;
  className?: string;
}

function MarkdownView({ children, fromTool = false, size = "lead", streaming = false, className = "" }: Props) {
  const text = useMemo(() => prepareMarkdown(children, fromTool), [children, fromTool]);
  const components = useMemo(() => buildComponents(streaming), [streaming]);
  return (
    <div className={`min-w-0 break-words text-ink ${SIZE[size]} ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: true }]]} rehypePlugins={[[rehypeKatex, KATEX_OPTIONS]]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** Memoised on the text and the flags, so that a parent that renders often does not parse again. */
export const Markdown = memo(MarkdownView);
