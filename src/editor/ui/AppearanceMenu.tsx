import type { JSX } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { control } from '../styles/tokens.stylex.js';
import { useAppearance } from '../state/appearance.js';
import { THEME_LABELS, THEME_PREFERENCES, isThemePreference } from '../state/theme.js';
import { DENSITY_LABELS, DENSITY_PREFERENCES, isDensityPreference } from '../state/density.js';
import { IconButton } from './Button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './Menu.js';

/**
 * The appearance switch: one icon button, two radio groups (theme, density).
 *
 * The glyph shows the theme *preference*, not the result — a monitor for "follow system" even when
 * that currently means dark — because the button is where the user changes the setting, and a moon
 * on a button that is set to follow the system would suggest it is set to dark.
 */
export function AppearanceMenu(): JSX.Element {
  const { theme, density } = useAppearance();
  const Glyph = theme.preference === 'system' ? Monitor : theme.preference === 'dark' ? Moon : Sun;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={`Appearance: ${THEME_LABELS[theme.preference]}, ${DENSITY_LABELS[density.preference]}`}>
          <Glyph size={control.icon} />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={theme.preference}
          onValueChange={(value) => {
            if (isThemePreference(value)) theme.setPreference(value);
          }}
        >
          {THEME_PREFERENCES.map((preference) => (
            <DropdownMenuRadioItem key={preference} value={preference}>
              {THEME_LABELS[preference]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Density</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={density.preference}
          onValueChange={(value) => {
            if (isDensityPreference(value)) density.setPreference(value);
          }}
        >
          {DENSITY_PREFERENCES.map((preference) => (
            <DropdownMenuRadioItem key={preference} value={preference}>
              {DENSITY_LABELS[preference]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
