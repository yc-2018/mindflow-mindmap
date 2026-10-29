import { memo, useMemo, Suspense, lazy } from 'react';

const MarkdownRenderer = lazy(() => import('./MarkdownRenderer'));

interface Props {
	source: string;
	/** Extra class on the wrapper, e.g. for the root node's white text. */
	className?: string;
}

/**
 * Render a node label as Markdown.
 *
 * Plain text takes a fast path with zero parser cost, and the Markdown parser
 * itself is loaded lazily so the initial bundle stays small. Line breaks the
 * user types are preserved by `remark-breaks` in the renderer.
 */
function MarkdownLabel({ source, className }: Props) {
	const text = source ?? '';

	/**
	 * Fast path: no markdown syntax and no newlines -> plain string.
	 *
	 * The character set must include `=` because `==text==` is our highlight
	 * syntax. Leaving it out made `==新主题==` take the plain path, so the
	 * Markdown renderer (and its highlight plugin) never ran and the user saw
	 * the raw equals signs.
	 */
	const isPlain = useMemo(() => !/[*_`~#>|[\]()!=\n-]/.test(text), [text]);

	if (isPlain) {
		return <span className={`md-label md-label--plain${className ? ` ${className}` : ''}`}>{text}</span>;
	}

	return (
		<div className={`md-label${className ? ` ${className}` : ''}`}>
			<Suspense fallback={<span className="md-label--plain">{text}</span>}>
				<MarkdownRenderer source={text} />
			</Suspense>
		</div>
	);
}

export default memo(MarkdownLabel);
