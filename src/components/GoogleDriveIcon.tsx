import type { Component } from "../utils/types";

interface Props {
  className?: string;
  size?: number;
}

export default function GoogleDriveIcon({ className = "", size = 24 }: Props): Component {
  return (
    <svg
      viewBox="0 0 87.3 78"
      width={size}
      height={size}
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M6.6 66.85L10.45 73.5C11.25 74.9 12.4 76 13.75 76.8L27.5 53H0C0 54.55 0.4 56.1 1.2 57.5L6.6 66.85Z"
        fill="#0066DA"
      />
      <path
        d="M43.65 25L29.9 1.2C28.55 2 27.4 3.1 26.6 4.5L1.2 48.5C0.4 49.9 0 51.45 0 53H27.5L43.65 25Z"
        fill="#00AC47"
      />
      <path
        d="M73.55 76.8C74.9 76 76.05 74.9 76.85 73.5L86.1 57.5C86.9 56.1 87.3 54.55 87.3 53H59.8L73.55 76.8Z"
        fill="#EA4335"
      />
      <path
        d="M43.65 25L57.4 1.2C56.05 0.4 54.5 0 52.9 0H34.4C32.8 0 31.25 0.45 29.9 1.2L43.65 25Z"
        fill="#00832D"
      />
      <path
        d="M59.8 53H27.5L13.75 76.8C15.1 77.6 16.65 78 18.25 78H69.05C70.65 78 72.2 77.55 73.55 76.8L59.8 53Z"
        fill="#2684FC"
      />
      <path
        d="M73.4 26.5L60.7 4.5C59.9 3.1 58.75 2 57.4 1.2L43.65 25L59.8 53H87.3C87.3 51.45 86.9 49.9 86.1 48.5L73.4 26.5Z"
        fill="#FFBA00"
      />
    </svg>
  );
}
