export function uid(prefix = 'n'): string {
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	const hex = Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	return `${prefix}_${hex}`;
}
