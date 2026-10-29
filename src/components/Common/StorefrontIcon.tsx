import React from 'react';
import { StorefrontId } from '../../contracts/platform';

interface StorefrontIconProps {
  storefrontId: StorefrontId | string;
  className?: string;
  decorative?: boolean;
}

export const StorefrontIcon: React.FC<StorefrontIconProps> = ({
  storefrontId,
  className = 'w-4 h-4',
  decorative = false,
}) => {
  const id = storefrontId.toLowerCase();
  const cleanClassName = className
    .replace(/\bdrop-shadow(?:-[^\s]+)?\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const getA11yProps = (label: string) =>
    decorative
      ? { 'aria-hidden': 'true' as const }
      : { role: 'img' as const, 'aria-label': label };

  switch (id) {
    case 'steam':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          className={cleanClassName}
          {...getA11yProps('Steam')}
        >
          <path d="M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658c.545-.371 1.203-.59 1.912-.59.063 0 .125.004.188.008l2.861-4.142V8.93c0-2.485 2.023-4.508 4.508-4.508 2.484 0 4.507 2.023 4.507 4.508 0 2.484-2.023 4.507-4.507 4.507-.221 0-.437-.021-.65-.051l-4.048 2.923c0 .064.004.127.004.192 0 1.849-1.503 3.352-3.352 3.352-1.637 0-2.999-1.181-3.29-2.735L.373 15.11C1.842 20.245 6.49 24 12 24c6.627 0 12-5.373 12-12S18.627 0 11.979 0zm4.013 7.545c0-.756.613-1.369 1.369-1.369.756 0 1.369.613 1.369 1.369 0 .756-.613 1.369-1.369 1.369-.756 0-1.369-.613-1.369-1.369zm-7.616 11.9c-.838 0-1.517-.68-1.517-1.517 0-.482.227-.91.579-1.188l2.127.879c-.06.208-.093.428-.093.655 0 .837-.679 1.517-1.517 1.517zm8.441-7.142c-.454 0-.895-.084-1.306-.237l-2.06 1.488c.205.419.323.889.323 1.388 0 1.776-1.445 3.221-3.221 3.221-.375 0-.73-.066-1.062-.185l-2.197-.908c.553-1.085 1.688-1.828 3.003-1.828.188 0 .371.016.55.047l2.844-4.118c-.463-.642-.74-1.428-.74-2.28 0-2.146 1.745-3.891 3.891-3.891 2.146 0 3.891 1.745 3.891 3.891 0 2.146-1.745 3.891-3.891 3.891z" />
        </svg>
      );

    case 'gog':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          className={cleanClassName}
          {...getA11yProps('GOG.com')}
        >
          <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm3.8 14.5c-1.1.9-2.5 1.3-4.1 1.3-3.4 0-5.7-2.3-5.7-5.8 0-3.5 2.3-5.8 5.7-5.8 1.6 0 3 .5 4 1.3l-1.3 1.9c-.8-.6-1.7-.9-2.7-.9-2 0-3.3 1.4-3.3 3.5s1.3 3.5 3.3 3.5c1.1 0 2-.4 2.8-1v-1.7h-3v-2.2h5.3v5.9z" />
        </svg>
      );

    case 'epic':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          className={cleanClassName}
          {...getA11yProps('Epic Games')}
        >
          <path d="M4.5 2.5C4.5 2.5 12 0 12 0s7.5 2.5 7.5 2.5v13.7c0 4.3-7.5 7.8-7.5 7.8s-7.5-3.5-7.5-7.8V2.5zm3.2 4.2v10.6h8.6v-2.4h-5.9v-2.2h4.8v-2.4h-4.8V9.1h5.7V6.7H7.7z" />
        </svg>
      );

    case 'xbox':
      return (
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={cleanClassName}
          {...getA11yProps('Xbox')}
        >
          <path d="M7.202 15.967a7.987 7.987 0 0 1-3.552-1.26c-.898-.585-1.101-.826-1.101-1.306 0-.965 1.062-2.656 2.879-4.583C6.459 7.723 7.897 6.44 8.052 6.475c.302.068 2.718 2.423 3.622 3.531 1.43 1.753 2.088 3.189 1.754 3.829-.254.486-1.83 1.437-2.987 1.802-.954.301-2.207.429-3.239.33Zm-5.866-3.57C.589 11.253.212 10.127.03 8.497c-.06-.539-.038-.846.137-1.95.218-1.377 1.002-2.97 1.945-3.95.401-.417.437-.427.926-.263.595.2 1.23.638 2.213 1.528l.574.519-.313.385C4.056 6.553 2.52 9.086 1.94 10.653c-.315.852-.442 1.707-.306 2.063.091.24.007.15-.3-.319Zm13.101.195c.074-.36-.019-1.02-.238-1.687-.473-1.443-2.055-4.128-3.508-5.953l-.457-.575.494-.454c.646-.593 1.095-.948 1.58-1.25.381-.237.927-.448 1.161-.448.145 0 .654.528 1.065 1.104a8.372 8.372 0 0 1 1.343 3.102c.153.728.166 2.286.024 3.012a9.495 9.495 0 0 1-.6 1.893c-.179.393-.624 1.156-.82 1.404-.1.128-.1.127-.043-.148ZM7.335 1.952c-.67-.34-1.704-.705-2.276-.803a4.171 4.171 0 0 0-.759-.043c-.471.024-.45 0 .306-.358A7.778 7.778 0 0 1 6.47.128c.8-.169 2.306-.17 3.094-.005.85.18 1.853.552 2.418.9l.168.103-.385-.02c-.766-.038-1.88.27-3.078.853-.361.176-.676.316-.699.312a12.246 12.246 0 0 1-.654-.319Z" />
        </svg>
      );

    case 'amazon':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          className={cleanClassName}
          {...getA11yProps('Amazon Prime')}
        >
          <path d="M13.918 16.924c-2.482 1.83-6.077 2.802-9.208 2.802-4.384 0-8.337-1.614-11.31-4.32-.236-.213-.024-.503.259-.34 3.208 1.846 7.086 2.956 11.051 2.956 2.766 0 5.807-.638 8.583-1.961.424-.2.784.307.34.613l.285.25zm1.536-1.536c-.317-.408-1.572-.193-2.17-.119-.18.022-.208-.134-.047-.247 1.042-.736 2.752-.524 3.016-.2 0 0 .343.376.104 1.488-.04.185-.183.218-.32.074-.537-.565-1.298-1.113-.583-.996zM12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2z" />
        </svg>
      );

    case 'ea':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          className={cleanClassName}
          {...getA11yProps('EA')}
        >
          <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 14.5h-4.5L7 13.7h3.8l.8-1.5H6.2L4.7 9.4h7.5l.8-1.6h-9l-1 2.1 1.7 3.3-1.7 3.3H13zm6.3 0h-2.1l-.8-2h-3.3l-.8 2h-2.1l3.5-7.2h2.1zm-3.5-3.7-.9-2.3-.9 2.3z" />
        </svg>
      );

    case 'ubisoft':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          className={cleanClassName}
          {...getA11yProps('Ubisoft')}
        >
          <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8zm0-13a5 5 0 0 0-4.9 4.1 3.5 3.5 0 0 1 5.9 2.5 1.5 1.5 0 0 0 2-1.4 3 3 0 0 0-3-5.2z" />
        </svg>
      );

    default:
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={cleanClassName}
          {...getA11yProps(storefrontId)}
        >
          <rect x="2" y="6" width="20" height="12" rx="3" />
          <path d="M6 12h4m-2-2v4m7-2h.01m3 0h.01" />
        </svg>
      );
  }
};

export function getStorefrontDisplayName(id: string): string {
  switch (id.toLowerCase()) {
    case 'steam':
      return 'Steam';
    case 'gog':
      return 'GOG.com';
    case 'epic':
      return 'Epic Games';
    case 'xbox':
      return 'Xbox';
    case 'amazon':
      return 'Prime Gaming';
    case 'ea':
      return 'EA App';
    case 'ubisoft':
      return 'Ubisoft';
    case 'bnet':
      return 'Battle.net';
    case 'itch':
      return 'itch.io';
    default:
      return id.charAt(0).toUpperCase() + id.slice(1);
  }
}
