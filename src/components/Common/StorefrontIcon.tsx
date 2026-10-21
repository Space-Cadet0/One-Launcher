import React from 'react';
import { StorefrontId } from '../../contracts/platform';

interface StorefrontIconProps {
  storefrontId: StorefrontId | string;
  className?: string;
}

export const StorefrontIcon: React.FC<StorefrontIconProps> = ({
  storefrontId,
  className = 'w-4 h-4',
}) => {
  const id = storefrontId.toLowerCase();
  const cleanClassName = className
    .replace(/\bdrop-shadow(?:-[^\s]+)?\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  switch (id) {
    case 'steam':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          className={cleanClassName}
          aria-label="Steam"
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
          aria-label="GOG.com"
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
          aria-label="Epic Games"
        >
          <path d="M4.5 2.5C4.5 2.5 12 0 12 0s7.5 2.5 7.5 2.5v13.7c0 4.3-7.5 7.8-7.5 7.8s-7.5-3.5-7.5-7.8V2.5zm3.2 4.2v10.6h8.6v-2.4h-5.9v-2.2h4.8v-2.4h-4.8V9.1h5.7V6.7H7.7z" />
        </svg>
      );

    case 'xbox':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          className={cleanClassName}
          aria-label="Xbox"
        >
          <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm-2.08 4.792c.677 0 2.08 2.062 2.08 2.062s1.403-2.062 2.08-2.062c2.096 0 5.176 1.83 6.942 4.148-1.503 2.127-4.471 6.554-6.31 9.479-.387-.714-1.921-3.662-2.712-5.187-.666 1.282-2.325 4.473-2.712 5.187-1.839-2.925-4.807-7.352-6.31-9.479 1.766-2.318 4.846-4.148 6.942-4.148z" />
        </svg>
      );

    case 'amazon':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          className={cleanClassName}
          aria-label="Amazon Prime"
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
          aria-label="EA"
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
          aria-label="Ubisoft"
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
          aria-label={storefrontId}
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
