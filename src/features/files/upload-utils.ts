/** Загрузка идёт base64 в JSON: сервер ограничивает декодированный размер, проверяем и здесь. */
export const MAX_UPLOAD_BYTES = 1_200_000;

export function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Не удалось прочитать «" + file.name + "»"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      if (comma < 0) reject(new Error("Не удалось прочитать «" + file.name + "»"));
      else resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}
