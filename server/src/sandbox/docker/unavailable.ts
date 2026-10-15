/**
 * Почему контейнер не запустился, в одном месте.
 *
 * Отсутствие Docker видит и панель терминала, и предпросмотр, и старт сервера, и модель — как
 * результат инструмента. Везде это должно быть объяснение с выходом, а не повтор ошибки запуска
 * процесса (`spawn docker ENOENT`): хост без Docker — это не сломанный проект, и человеку за
 * терминалом нужно знать, что доступно вместо контейнера.
 */
export const DOCKER_UNAVAILABLE_PREFIX = "Docker недоступен на этом хосте";

/**
 * Отказ запуска процесса docker: ENOENT — бинарника нет, EACCES — есть, но недоступен (нет прав
 * или сокета демона). Команда, которая просто завершилась с ошибкой, сюда не попадает: она
 * возвращается вызывающему со своим кодом и stderr.
 */
export function dockerMissing(error:unknown){
  const message=error instanceof Error?error.message:String(error);
  return message.includes(DOCKER_UNAVAILABLE_PREFIX)||/ENOENT|EACCES|EPERM/.test(message);
}

export function dockerUnavailableMessage(error:unknown){
  const detail=error instanceof Error?error.message:String(error);
  return DOCKER_UNAVAILABLE_PREFIX+": "+detail+
    ". Контейнерные команды — терминал агента, npm install, сборка проекта и контейнерный предпросмотр — работать не будут."+
    " Без Docker доступны файловые инструменты и статический предпросмотр проекта, которому не нужна сборка (обычный index.html/CSS/JS или уже собранный dist).";
}
