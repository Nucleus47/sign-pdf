/**
 * Small line icons, drawn in the text colour. Each one is defined once here.
 * An icon is decoration: the button or link next to it carries the words.
 */
export type IconName = 'email' | 'download' | 'device';

const PATHS: Readonly<Record<IconName, readonly string[]>> = {
  // An envelope.
  email: ['M3 6.5A1.5 1.5 0 0 1 4.5 5h15A1.5 1.5 0 0 1 21 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z', 'm3.5 6 8.5 7 8.5-7'],
  // An arrow down onto a tray.
  download: ['M12 4v11', 'm7 10 5 5 5-5', 'M5 19h14'],
  // A phone.
  device: ['M8.5 3h7A1.5 1.5 0 0 1 17 4.5v15a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 7 19.5v-15A1.5 1.5 0 0 1 8.5 3z', 'M11 18h2'],
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-icon={name}
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
