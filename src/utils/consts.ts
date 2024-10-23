import { BaseDirectory } from "@tauri-apps/api/fs";

const BASE_DIRECTORY: { dir: BaseDirectory } = { dir: BaseDirectory.Document };

const MAIN_FOLDER: string = "lyra";

const PAGES: Pages = {
  presentation: "/",
  list: "/list",
  backup: "/backup",
  support: "/support",
  preferences: "/preferences",
  file: "/file",
  updates: "/updates",
  myFiles: "/myfiles",
};

const THEMES: Themes = {
  clearNigth: "clear-nigth",
  darkNigth: "dark-nigth",
  Day: "sunny-day",
};

const LANGS: Langs = {
  es: "ES",
  en: "EN",
};

const TEXT_SIZES: TextSizes = {
  sm: "15px",
  md: "16px",
  lg: "18px",
  xl: "20px",
  xxl: "22px",
  xxxl: "24px",
};

const TEXT_ALIGNS: AlignsText = {
  start: "text-start",
  center: "text-center",
  end: "text-right",
};

const WELCOME_ES: string = "Bienvenido a Lyra.txt";

const WELCOME_EN: string = "Welcome to Lyra.txt";

const INTRO_ES: string = `Lyra es el espacio ideal para escribir sin distracciones. Perfecta para quienes disfrutan de la escritura enfocada, ya sea un libro, pensamientos, o un diario personal. Funciona sin conexión, manteniendo tus textos seguros y privados en tu dispositivo, sin recopilar datos.\n\nCon temas personalizables y comandos de teclado, ofrece una experiencia de escritura fluida adaptada a tu estilo.\n\nDisponible en español e inglés, con más idiomas próximamente.\n\n¡Empieza a escribir con Lyra y da vida a tus ideas!`;

const INTRO_EN: string = `Lyra is the perfect space for distraction-free writing. Ideal for those who enjoy focused writing, whether it’s a book, thoughts, or a personal journal. It works offline, keeping your texts secure and private on your device, with no data collection.\n\nWith customizable themes and keyboard shortcuts, it offers a smooth writing experience tailored to your style.\n\nAvailable in Spanish and English, with more languages coming soon.\n\nStart writing with Lyra and bring your ideas to life!`;

export {
  BASE_DIRECTORY,
  INTRO_EN,
  INTRO_ES,
  LANGS,
  MAIN_FOLDER,
  PAGES,
  TEXT_ALIGNS,
  TEXT_SIZES,
  THEMES,
  WELCOME_EN,
  WELCOME_ES,
};

interface TextSizes {
  sm: string;
  md: string;
  lg: string;
  xl: string;
  xxl: string;
  xxxl: string;
}

interface AlignsText {
  start: string;
  center: string;
  end: string;
}

interface Pages {
  presentation: string;
  list: string;
  backup: string;
  support: string;
  preferences: string;
  file: string;
  updates: string;
  myFiles: string;
}

interface Themes {
  clearNigth: string;
  darkNigth: string;
  Day: string;
}

interface Langs {
  es: string;
  en: string;
}
