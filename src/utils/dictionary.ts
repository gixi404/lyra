import usePreferences from "../hooks/usePreferences";
import { LANGS } from "./consts";

function userLanguage(enText: string, esText: string): string {
  const { myLangValue } = usePreferences();
  const text: string = myLangValue() == LANGS.es ? esText : enText;
  return text;
}

function translations() {
  const dictionary = {
    StartTyping: userLanguage("Start typing...", "Comienza a escribir..."),
    Suggestions: userLanguage("Suggestions", "Sugerencias"),
    SuggestionsText: userLanguage(
      "Your suggestions help us improve. If you have ideas or improvements that you would like to see in Lyra soon, feel free to send them.",
      "Tus sugerencias nos ayudan a mejorar. Si tienes ideas o mejoras que te gustaría ver en Lyra pronto, no dudes en enviarlas."
    ),
    Errors: userLanguage("Errors", "Errores"),
    ErrorsText: userLanguage(
      "If you find a bug in the app, please provide a detailed description of the problem, steps to reproduce it, and any screenshots that may help.",
      "Si encuentras un error en la aplicación, por favor proporciona una descripción detallada del problema, pasos para reproducirlo y cualquier captura de pantalla que pueda ayudar."
    ),
    Aligment: userLanguage("Aligment", "Alineación"),
    Left: userLanguage("Left", "Izquierda"),
    Right: userLanguage("Right", "Derecha"),
    Centered: userLanguage("Centered", "Centrado"),
    RememberToUseKeyboardShortcuts: userLanguage(
      "Remember to use keyboard shortcuts!",
      "¡Recuerda usar comandos de teclado!"
    ),
    LastModified: userLanguage("Last modified", "Última modificación"),
    Archived: userLanguage("Paper Bin", "Papelera"),
    Confirm: userLanguage("Confirm", "Confirmar"),
    Font: userLanguage("Font", "Fuente"),
    About: userLanguage("About", "Acerca de"),
    Preferences: userLanguage("Preferences", "Preferencias"),
    File: userLanguage("File", "Archivo"),
    List: userLanguage("List", "Lista"),
    Search: userLanguage("Search", "Buscar"),
    CheckSpelling: userLanguage("Check spelling", "Revisar ortografía"),
    ReduceTextSize: userLanguage(
      "Reduce text size",
      "Reducir tamaño del texto"
    ),
    EnterTheFileName: userLanguage(
      "Enter the file name",
      "Ingrese el nombre del archivo"
    ),
    IncreaseTextSize: userLanguage(
      "Increase text size",
      "Aumentar tamaño del texto"
    ),
    SpellcheckerOff: userLanguage("spellchecker off", "ortografía desactivada"),
    SpellcheckerOn: userLanguage("spellchecker on", "ortografía activada"),
    ContactThisEmailForQuestions: userLanguage(
      "Contact this email for questions about lyra",
      "Contacta este correo para preguntas sobre lyra"
    ),
    TextOpacity: userLanguage("Text opacity", "Opacidad del texto"),
    LetterSpacing: userLanguage("Letter spacing", "Espaciado entre letras"),
    FullScreen: userLanguage("Full screen", "Pantalla completa"),
    Version: userLanguage("Version", "Versión"),
    DevelopedBy: userLanguage("Developed by Gixi", "Desarrollado por Gixi"),
    Start: userLanguage("Start", "Iniciar"),
    LocalSaved: userLanguage("local saved", "guardado local"),
    OfflineAccess: userLanguage("offline access", "acceso sin conexión"),
    MinimalDesing: userLanguage("minimal design", "diseño minimalista"),
    FocusedWriting: userLanguage("focused writing", "escritura enfocada"),
    AlternateText: userLanguage("Alternate text", "Alternar texto"),
    On: userLanguage("on", "del"),
    Modified: userLanguage("Modified", "Modificado"),
    CopiedToClipboard: userLanguage(
      "Copied to clipboard",
      "Copiado al portapapeles"
    ),
    CopyText: userLanguage("Copy text", "Copiar texto"),
    AddYourFirstAnnotation: userLanguage(
      "Add your first record",
      "Agrega tu primer registro"
    ),
    Add: userLanguage("Add", "Agregar"),
    InvalidName: userLanguage("Invalid name", "Nombre inválido"),
    NameAlreadyExists: userLanguage(
      "Name already exists",
      "El nombre ya existe"
    ),
    Move: userLanguage("Move", "Mover"),
    AreYouSure: userLanguage("Are you sure?", "¿Estás seguro?"),
    NoSpecialCharacters: userLanguage(
      "No special characters allowed",
      "No se permiten caracteres especiales"
    ),
    VeryLongName: userLanguage(
      "Very long name",
      "El nombre es demasiado extenso"
    ),
    WordCount: userLanguage("Word count", "Contar palabras"),
    Enabled: userLanguage("Enabled", "Activado"),
    Disabled: userLanguage("Disabled", "Desactivado"),
    Word: userLanguage("word", "palabra"),
    Words: userLanguage("words", "palabras"),
    EditedName: userLanguage("Edited name", "Nombre editado"),
    Cancel: userLanguage("Cancel", "Cancelar"),
    Change: userLanguage("Change", "Cambiar"),
    EnterNewName: userLanguage("Enter new name", "Ingrese el nuevo nombre"),
    Help: userLanguage("Help", "Ayuda"),
    Commands: userLanguage("Commands", "Comandos"),
    Language: userLanguage("Language", "Idioma"),
    Themes: userLanguage("Themes", "Temas"),
    Support: userLanguage("Support", "Soporte"),
    Night: userLanguage("Night", "Noche"),
    Day: userLanguage("Day", "Día"),
    Alignment: userLanguage("Alignment", "Alineación"),
    EnterName: userLanguage("Enter name", "Ingresa un nombre"),
    RepeatedItem: userLanguage("Repeated name", "Nombre repetido"),
    DeletedFile: userLanguage("Deleted record", "Archivo eliminado"),
    MoveToTrash: userLanguage(
      "Do you want to move this record to the paper bin?",
      "¿Quieres mover este archivo a la papelera?"
    ),
    SentToTrash: userLanguage("Sent to the paper bin", "Enviado a la papelera"),
    NothingHere: userLanguage("Nothing here...", "Nada por aquí..."),

    Loading: userLanguage("Loading...", "Cargando..."),
    RestoreQuestion: userLanguage(
      "Do you want to restore this record?",
      "¿Deseas restaurar este archivo?"
    ),
    DeleteQuestion: userLanguage(
      "Do you want to remove this record?",
      "¿Deseas eliminar este archivo?"
    ),
    Delete: userLanguage("Delete", "Eliminar"),
    Recover: userLanguage("Recover", "Recuperar"),
    FileRecovered: userLanguage("Record recovered", "Archivo recuperado"),
    YourFilesAreLocatedIn: userLanguage(
      "Your files are located in > Documents > lyra",
      "Tus archivos se encuentran en > Documentos > lyra"
    ),
    OpenFolder: userLanguage("Open folder", "Abrir carpeta"),
    MyFiles: userLanguage("My files", "Mis archivos"),
  };

  return dictionary;
}

export default translations;
