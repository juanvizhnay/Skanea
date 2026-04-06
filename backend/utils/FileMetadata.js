/**
 * Clase para manejar metadatos de archivos generados
 * El ID es SOLO para tracking interno, NO para el nombre físico
 */
class FileMetadata {
  /**
   * @param {string} cleanName - Nombre base sin extensión (ej: "numeros")
   * @param {string} extension - Extensión del archivo (ej: "xlsx")
   * @param {string} fileId - ID único solo para tracking interno
   * @param {string} localPath - Ruta completa al archivo físico (siempre con nombre limpio)
   */
  constructor(cleanName, extension, fileId, localPath) {
    // Nombre del archivo físico (SIEMPRE limpio, sin ID)
    this.internalName = `${cleanName}.${extension}`;

    // Nombre para mostrar al usuario (igual que internalName)
    this.displayName = `${cleanName}.${extension}`;

    // Ruta completa al archivo físico (con nombre limpio)
    this.localPath = localPath;

    // Nombre base sin extensión
    this.baseName = cleanName;

    // ID único solo para tracking interno de la app
    this.fileId = fileId;

    // Extensión
    this.extension = extension;
  }

  /**
   * Retorna el objeto para enviar al frontend
   */
  toJSON() {
    return {
      internalName: this.internalName,
      displayName: this.displayName,
      localPath: this.localPath,
      baseName: this.baseName,
      fileId: this.fileId,
      extension: this.extension
    };
  }

  /**
   * Retorna el nombre para descargar (siempre limpio)
   */
  getDownloadName() {
    return this.displayName;
  }
}

export default FileMetadata;

