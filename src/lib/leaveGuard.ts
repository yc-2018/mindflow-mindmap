import { useEffect } from 'react';

/**
 * Warn before the visitor loses unsaved work.
 *
 * Two channels, matching the two ways people leave an editor:
 *
 *  1. browser close / reload / external navigation → the native
 *     `beforeunload` prompt. It fires once per attempt and the browser shows
 *     its own generic dialog; that satisfies "没有保存就关闭要拦截一次".
 *
 *  2. in-app 返回 buttons (our SPA router never unloads the page, so
 *     beforeunload would not fire) → `confirmLeave()` returns false when there
 *     are unsaved changes and the user refuses the confirm dialog.
 *
 * `dirtyRef` is passed as a ref so the listeners never go stale.
 */
export function useUnsavedGuard(dirtyRef: { current: boolean }): void {
	useEffect(() => {
		const onBeforeUnload = (e: BeforeUnloadEvent) => {
			if (!dirtyRef.current) return;
			e.preventDefault();
			// Chrome requires returnValue to be set for the dialog to appear
			e.returnValue = '';
		};
		window.addEventListener('beforeunload', onBeforeUnload);
		return () => window.removeEventListener('beforeunload', onBeforeUnload);
	}, [dirtyRef]);
}

/** Guard for SPA route changes; shows the confirm once when dirty. */
export function confirmLeave(dirty: boolean, message = '有未保存的修改，确定要离开吗？'): boolean {
	if (!dirty) return true;
	return window.confirm(message);
}
