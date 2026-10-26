import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

/**
 * The Markdown parser, isolated in its own module so it can be code-split.
 * `remark-breaks` turns single newlines into <br>, preserving the exact line
 * breaks the user typed in the node editor.
 */
function MarkdownRenderer({ source }: { source: string }) {
	return (
		<ReactMarkdown
			remarkPlugins={[remarkGfm, remarkBreaks]}
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
