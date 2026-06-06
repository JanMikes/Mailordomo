/** The Today page header: the view title (sentence case) + a manual sync + the settings knobs popover. */
import { SettingsPopover } from './settings-popover';
import { SyncNowButton } from './sync-now-button';

export function TodayPageHeader() {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Today</h1>
        <p className="text-muted-foreground text-sm">What needs you, ranked by what you owe.</p>
      </div>
      <div className="flex items-center gap-2">
        <SyncNowButton />
        <SettingsPopover />
      </div>
    </div>
  );
}
