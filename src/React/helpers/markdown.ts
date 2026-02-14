import MarkdownIt from "markdown-it";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: true,
});

const headingOpenRule: NonNullable<MarkdownIt["renderer"]["rules"]["heading_open"]> = (tokens, idx): string => {
  const tag = tokens[idx]?.tag ?? "h1";
  const styles: Record<string, string> = {
    h1: ' style="margin:24px 0 10px;font-size:28px;color:#111;border-bottom:2px solid #e0e0e0;padding-bottom:8px"',
    h2: ' style="margin:20px 0 8px;font-size:22px;color:#222;border-bottom:1px solid #e0e0e0;padding-bottom:6px"',
    h3: ' style="margin:16px 0 8px;font-size:18px;color:#333"',
    h4: ' style="margin:14px 0 6px;font-size:16px;color:#444"',
    h5: ' style="margin:12px 0 6px;font-size:15px;color:#555"',
    h6: ' style="margin:12px 0 6px;font-size:14px;color:#555"',
  };
  return `<${tag}${styles[tag] ?? ""}>`;
};
md.renderer.rules.heading_open = headingOpenRule;

const paragraphOpenRule = (): string => '<p style="margin:8px 0;line-height:1.75">';
const hrRule = (): string => '<hr style="border:none;border-top:1px solid #ddd;margin:20px 0"/>';
md.renderer.rules.paragraph_open = paragraphOpenRule;
md.renderer.rules.hr = hrRule;

const blockquoteOpenRule = (): string =>
  '<blockquote style="border-left:4px solid #3366cc;margin:8px 0;padding:8px 16px;color:#555;background:#f8f9fa;border-radius:0 6px 6px 0">';
md.renderer.rules.blockquote_open = blockquoteOpenRule;

const bulletListOpenRule = (): string => '<ul style="padding-left:24px;margin:8px 0">';
const orderedListOpenRule = (): string => '<ol style="padding-left:24px;margin:8px 0">';
const listItemOpenRule = (): string => '<li style="margin:4px 0">';
md.renderer.rules.bullet_list_open = bulletListOpenRule;
md.renderer.rules.ordered_list_open = orderedListOpenRule;
md.renderer.rules.list_item_open = listItemOpenRule;

const codeInlineRule: NonNullable<MarkdownIt["renderer"]["rules"]["code_inline"]> = (tokens, idx): string => {
  const content = md.utils.escapeHtml(tokens[idx]?.content ?? "");
  return `<code style="background:#f0f0f5;padding:2px 6px;border-radius:4px;font-size:0.88em;color:#c7254e">${content}</code>`;
};
md.renderer.rules.code_inline = codeInlineRule;

const fenceRule: NonNullable<MarkdownIt["renderer"]["rules"]["fence"]> = (tokens, idx): string => {
  const content = md.utils.escapeHtml(tokens[idx]?.content ?? "");
  return `<pre style="background:#1e1e2e;color:#cdd6f4;padding:16px;border-radius:8px;overflow-x:auto;font-size:13px;line-height:1.6;margin:12px 0"><code>${content}</code></pre>`;
};
md.renderer.rules.fence = fenceRule;

const linkOpenRule: NonNullable<MarkdownIt["renderer"]["rules"]["link_open"]> = (
  tokens,
  idx,
  options,
  _env,
  self
): string => {
  const token = tokens[idx];
  if (token) {
    token.attrSet("target", "_blank");
    token.attrSet("rel", "noopener noreferrer");
    token.attrSet("style", "color:#3366cc;text-decoration:underline");
  }
  return self.renderToken(tokens, idx, options);
};
md.renderer.rules.link_open = linkOpenRule;

const imageRule: NonNullable<MarkdownIt["renderer"]["rules"]["image"]> = (
  tokens,
  idx,
  options,
  _env,
  self
): string => {
  const token = tokens[idx];
  if (token) {
    token.attrSet("style", "max-width:100%;border-radius:6px;margin:8px 0");
  }
  return self.renderToken(tokens, idx, options);
};
md.renderer.rules.image = imageRule;

const tableOpenRule = (): string => '<table style="border-collapse:collapse;width:100%;margin:12px 0;font-size:14px">';
const thOpenRule = (): string => '<th style="border:1px solid #ddd;padding:8px 12px;background:#f5f5f5;font-weight:600;text-align:left">';
const tdOpenRule = (): string => '<td style="border:1px solid #ddd;padding:8px 12px">';
md.renderer.rules.table_open = tableOpenRule;
md.renderer.rules.th_open = thOpenRule;
md.renderer.rules.td_open = tdOpenRule;

export function simpleMarkdownToHtml(src: string): string {
  return md.render(src);
}
