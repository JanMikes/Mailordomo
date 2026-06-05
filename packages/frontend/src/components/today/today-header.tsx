/** The Today page header: the view title (sentence case) + the settings knobs popover. */
import { SettingsPopover } from './settings-popover';

export function TodayPageHeader() {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Today</h1>
        <p className="text-muted-foreground text-sm">What needs you, ranked by what you owe.</p>
      </div>
      <SettingsPopover />
    </div>
  );
}
