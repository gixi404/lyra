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

const INTRO_ES: string = `Bienvenido a Lyra

Lyra es un espacio de escritura minimalista y libre de distracciones, diseñado para ayudarte a concentrarte en tus ideas, historias, notas o diarios personales.

Todos tus documentos se guardan de forma segura y privada directamente en tu equipo (en la carpeta Documentos/lyra), funcionando 100% sin conexion y sin recopilar ningun dato.

COMO FUNCIONA Y FUNCIONES PRINCIPALES

1. Escritura enfocada (Modo Zen):
   Al empezar a escribir, la interfaz y las barras se atenuan suavemente para que solo veas tus palabras. Al pausar o mover el raton, todo reaparece de forma fluida.

2. Atajos de teclado utiles:
   - Ctrl + F : Abre el buscador y reemplazo de palabras (con opcion de mayusculas y minusculas).
   - Ctrl + + / Ctrl + - : Aumenta o disminuye el tamano de letra al instante.
   - Ctrl + Z / Ctrl + Y : Deshace y rehace cambios conservando tu posicion en el texto.
   - F11 : Activa o desactiva la pantalla completa.
   - Esc : Cierra menus y ventanas flotantes abiertas.

3. Menu de opciones de archivo:
   - Informacion : Estadisticas detalladas (palabras, caracteres, parrafos, tiempo estimado de lectura y fechas).
   - Exportar : Exporta tu documento a formato PDF con un solo clic.
   - Renombrar y Archivar : Organiza tus textos o envialos a la papelera/archivados sin borrarlos de forma definitiva.

4. Preferencias personalizables:
   - Elige entre mas de 10 fuentes tipograficas de alta legibilidad.
   - Alterna entre tema Claro, Oscuro o Automatico segun tu sistema.
   - Ajusta alineacion, interlineado, contador de palabras y modo foco por parrafo en tiempo real.

Empieza a escribir cuando quieras. Puedes editar o eliminar esta nota en cualquier momento.`;

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
