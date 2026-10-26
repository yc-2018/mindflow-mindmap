/**
 * Client-side image preparation.
 *
 * The image host rejects files larger than 10 MB, so everything is re-encoded to
 * WebP before upload. If the result is still too large we progressively shrink
 * the dimensions / lower the quality until it fits.
 */

export const HOST_LIMIT_BYTES = 10 * 1024 * 1024; // pixhost hard limit
const TARGET_BYTES = 9.5 * 1024 * 1024; // leave a little headroom

/** Decode a File into a bitmap we can draw on a canvas. */
async function toBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
	if (typeof createImageBitmap === 'function') {
		try {
			return await createImageBitmap(file);
		} catch {
			/* fall through to <img> */
		}
	}
	const url = URL.createObjectURL(file);
	try {
		const img = new Image();
		img.decoding = 'sync';
		await new Promise<void>((resolve, reject) => {
			img.onload = () => resolve();
			img.onerror = () => reject(new Error('图片解码失败'));
			img.src = url;
		});
		return img;
	} finally {
		// the bitmap/img keeps its own copy, safe to revoke
		setTimeout(() => URL.revokeObjectURL(url), 0);
	}
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
	return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
}

/** True when this browser can actually encode WebP (Safari < 14 cannot). */
let webpSupported: boolean | null = null;
async function supportsWebp(): Promise<boolean> {
	if (webpSupported !== null) return webpSupported;
	try {
		const c = document.createElement('canvas');
		c.width = 1;
		c.height = 1;
		const blob = await canvasToBlob(c, 'image/webp', 0.8);
		webpSupported = Boolean(blob && blob.type === 'image/webp');
	} catch {
		webpSupported = false;
	}
	return webpSupported;
}

export interface PreparedImage {
	blob: Blob;
	filename: string;
	/** Final encoded size in bytes. */
	bytes: number;
	width: number;
	height: number;
	/** True when we had to downscale/compress beyond the initial WebP pass. */
	compressed: boolean;
}

/**
 * Convert any image file to WebP, compressing only when necessary.
 *
 * Strategy:
 *  1. Try WebP at quality 0.92 with the original dimensions.
 *  2. If that is still over the limit, step the quality down.
 *  3. If quality alone is not enough, halve the dimensions and retry.
 *  4. Animated GIFs are sent as-is (canvas would flatten the animation).
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
	const baseName = (file.name || 'image').replace(/\.[^.]+$/, '');

	// Keep GIF animations intact — re-encoding would freeze them on frame one.
	if (file.type === 'image/gif') {
		return {
			blob: file,
			filename: file.name || 'image.gif',
			bytes: file.size,
			width: 0,
			height: 0,
			compressed: false,
		};
	}

	if (!(await supportsWebp())) {
		// No WebP encoder: fall back to the original file, shrinking only if huge.
		if (file.size <= HOST_LIMIT_BYTES) {
			return {
				blob: file,
				filename: file.name || 'image.png',
				bytes: file.size,
				width: 0,
				height: 0,
				compressed: false,
			};
		}
		return downscaleOnly(file, baseName);
	}

	const bmp = await toBitmap(file);
	const srcW = 'width' in bmp ? bmp.width : 0;
	const srcH = 'height' in bmp ? bmp.height : 0;

	let scale = 1;
	let quality = 0.92;
	let compressed = false;
	let best: { blob: Blob; w: number; h: number } | null = null;

	// at most ~8 attempts, each either lowers quality or halves the size
	for (let attempt = 0; attempt < 8; attempt++) {
		const w = Math.max(1, Math.round(srcW * scale));
		const h = Math.max(1, Math.round(srcH * scale));

		const canvas = document.createElement('canvas');
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('无法创建画布');
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = 'high';
		ctx.drawImage(bmp as CanvasImageSource, 0, 0, w, h);

		const blob = await canvasToBlob(canvas, 'image/webp', quality);
		if (!blob) throw new Error('图片编码失败');

		best = { blob, w, h };

		if (blob.size <= TARGET_BYTES) break;

		compressed = true;
		if (quality > 0.6) {
			quality -= 0.12;
		} else {
			scale *= 0.75;
			quality = 0.82;
		}
	}

	if (!best) throw new Error('图片处理失败');

	if ('close' in bmp && typeof bmp.close === 'function') bmp.close();

	return {
		blob: best.blob,
		filename: `${baseName}.webp`,
		bytes: best.blob.size,
		width: best.w,
		height: best.h,
		compressed,
	};
}

/** Fallback path when WebP encoding is unavailable. */
async function downscaleOnly(file: File, baseName: string): Promise<PreparedImage> {
	const bmp = await toBitmap(file);
	const srcW = 'width' in bmp ? bmp.width : 0;
	const srcH = 'height' in bmp ? bmp.height : 0;
	let scale = 1;
	let best: Blob = file;
	let w = srcW;
	let h = srcH;

	for (let i = 0; i < 6 && best.size > TARGET_BYTES; i++) {
		scale *= 0.75;
		w = Math.max(1, Math.round(srcW * scale));
		h = Math.max(1, Math.round(srcH * scale));
		const canvas = document.createElement('canvas');
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext('2d');
		if (!ctx) break;
		ctx.drawImage(bmp as CanvasImageSource, 0, 0, w, h);
		const blob = await canvasToBlob(canvas, file.type || 'image/jpeg', 0.85);
		if (blob) best = blob;
	}

	if ('close' in bmp && typeof bmp.close === 'function') bmp.close();

	return {
		blob: best,
		filename: file.name || `${baseName}.jpg`,
		bytes: best.size,
		width: w,
		height: h,
		compressed: best !== file,
	};
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
