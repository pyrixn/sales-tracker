import { cn } from '@/lib/utils';
import { copyText } from '@/lib/reminders';
import { notify } from '@/lib/store';

/** An id shown in monospace that copies itself when pressed. A real button, so Tab and Enter work. */
export function CopyId({ value, label = 'ID', className }) {
  const text = String(value || '');
  async function copy(e) {
    e.stopPropagation();
    const ok = await copyText(text);
    notify(ok ? 'Copied' : 'Could not copy. Select the text and copy it.');
  }
  if (!text) return null;
  return (
    <button type="button" onClick={copy} aria-label={'Copy ' + label + ' ' + text} title={'Copy ' + label}
      className={cn('rounded-sm font-mono underline decoration-dotted underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring', className)}>
      {text}
    </button>
  );
}
