/**
 * Копирование в буфер: сначала современный API, затем скрытое поле. Панель и ответ агента
 * копируют текст по одной кнопке, и в браузере без разрешения на clipboard это не должно
 * выглядеть как «кнопка ничего не делает».
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Ниже — запасной путь для http-окружений и старых браузеров.
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  } catch {
    return false;
  }
}
