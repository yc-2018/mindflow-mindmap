import { memo, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeRaw from 'rehype-raw';
import { visit } from 'unist-util-visit';

/**
 * Turn `==text==` into <mark>text</mark>.
 *
 * GFM has no highlight syntax, so we add it as a tiny remark plugin. Doing it
 * here (not in CSS) keeps the stored label plain Markdown that any renderer can
 * round-trip.
 */
function remarkHighlight() {
	return (tree: any) => {
		visit(tree, 'text', (node: any, index: number | undefined, parent: any) => {
			if (!parent || index === undefined) return;
			const value = String(node.value);
			if (!value.includes('==')) return;

			/**
			 * Split on the highlight markers.
			 *
			 * `split` with a capture group returns the captured text as its own
			 * element, so `==新主题==` yields ["==新主题=="] — a single element. The
			 * old `parts.length < 2` guard treated that as "nothing to do", which
			 * is exactly why a label consisting ONLY of a highlight stayed raw
			 * while `前面 ==重点== 后面` worked.
			 */
			const parts = value.split(/(==[^=]+==)/g).filter(Boolean);
			if (!parts.some((p: string) => /^==[^=]+==$/.test(p))) return;

			const replacement = parts.map((part: string) => {
				const m = /^==([^=]+)==$/.exec(part);
				if (m) {
					return {
						type: 'emphasis',
						data: { hName: 'mark', hProperties: { className: 'md-mark' } },
						children: [{ type: 'text', value: m[1] }],
					};
				}
				return { type: 'text', value: part };
			});
			parent.children.splice(index, 1, ...replacement);
		});
	};
}

/**
 * The Markdown parser, isolated in its own module so it can be code-split.
 * `remark-breaks` turns single newlines into <br>, preserving the exact line
 * breaks the user typed in the node editor.
 */
function MarkdownRenderer({ source }: { source: string }) {
	const plugins = useMemo(() => [remarkGfm, remarkBreaks, remarkHighlight], []);

	return (
		<ReactMarkdown
			remarkPlugins={plugins}
			rehypePlugins={[rehypeRaw]}
			components={{
				// open links in a new tab, never navigate the editor away
				a: ({ children, href }) => (
					<a href={href} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>
						{children}
					</a>
				),
				// keep inline images from blowing up the node
				img: ({ src, alt }) => <img src={src} alt={alt ?? ''} className="md-label__img" draggable={false} />,
			}}
		>
			{source}
		</ReactMarkdown>
	);
}

export default memo(MarkdownRenderer);
