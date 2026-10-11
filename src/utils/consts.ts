import { BaseDirectory } from "@tauri-apps/plugin-fs";

const BASE_DIRECTORY: { baseDir: BaseDirectory } = { baseDir: BaseDirectory.Document };

const MAIN_FOLDER: string = "lyra";

const PAGES: Pages = {
  list: "/",
  file: "/file",
  preferences: "/preferences",
};

const THEMES: Themes = {
  clearNigth: "clear-nigth",
  darkNigth: "dark-nigth",
  Day: "sunny-day",
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

const INTRO_ES: string = `Lyra es el espacio ideal para escribir sin distracciones. Perfecta para quienes disfrutan de la escritura enfocada, ya sea un libro, pensamientos, o un diario personal. Funciona sin conexión, manteniendo tus textos seguros y privados en tu dispositivo, sin recopilar datos.\n\nCon temas personalizables, ofrece una experiencia de escritura fluida adaptada a tu estilo.\n\nDisponible en español.\n\n¡Empieza a escribir con Lyra y da vida a tus ideas!`;

export {
  BASE_DIRECTORY,
  INTRO_ES,
  MAIN_FOLDER,
  PAGES,
  TEXT_ALIGNS,
  TEXT_SIZES,
  THEMES,
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
  list: string;
  file: string;
  preferences: string;
}

interface Themes {
  clearNigth: string;
  darkNigth: string;
  Day: string;
}
