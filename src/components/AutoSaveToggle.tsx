import { Save } from 'lucide-react';

import { setAutoSave, useAutoSave } from '../lib/autoSave';

interface Props {
	/** Whether the document currently has changes that are not stored yet. */
	dirty: boolean;
	/** Explicit save (the 保存 button when auto-save is off). */
	onSave: () => void;
	disabled?: boolean;
}

/**
 * Auto-save switch for editor headers, plus a manual 保存 button while it is
 * off.
 *
 * The preference lives in `lib/autoSave` (shared by all three editors, on by
 * default). This component is just the control: flipping it takes effect at
 * once, and switching back on lets each editor flush anything the user changed
 * while they were in manual mode.
 */
export default function AutoSaveToggle({ dirty, onSave, disabled = false }: Props) {
	const on = useAutoSave();

	return (
		<div className="autosave" title={on ? '自动保存已开启：停止输入后自动写入' : '自动保存已关闭：改动需手动保存'}>
			<button
				type="button"
				role="switch"
				aria-checked={on}
				className={`autosave__switch${on ? ' is-on' : ''}`}
				disabled={disabled}
				onClick={() => setAutoSave(!on)}
			>
				<span className="autosave__knob" />
				<span className="autosave__text">{on ? '自动保存' : '手动保存'}</span>
			</button>
			{!on ? (
				<button
					type="button"
					className={`btn-icon-text autosave__save${dirty ? ' is-need' : ''}`}
					onClick={onSave}
					disabled={disabled || !dirty}
					title="保存 (Ctrl+S)"
				>
					<Save size={14} strokeWidth={2} />
					{dirty ? '保存' : '已保存'}
				</button>
			) : null}
		</div>
	);
}
