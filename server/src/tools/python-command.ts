/**
 * Команда установки Python-зависимостей.
 *
 * Имя пакета проверяется вызывающим кодом, но версия (`pkg>=1`) содержит символы, которые
 * оболочка поняла бы как перенаправление. Поэтому каждый аргумент ставится в одинарные кавычки;
 * список аргументов фиксирован, и кавычки не мешают ни одному флагу.
 */
export function shellQuote(value: string) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function buildPipInstallCommand(input: {
  packages: string[];
  upgrade?: boolean;
  extraFlags?: string[];
}) {
  const args = [
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    "--no-input",
    ...(input.extraFlags ?? []),
    "--target",
    ".python",
    ...(input.upgrade ? ["--upgrade"] : []),
    ...(input.packages.length ? input.packages : ["-r", "requirements.txt"]),
  ];
  return "python3 " + args.map(shellQuote).join(" ");
}
