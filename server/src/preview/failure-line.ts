/**
 * Причина отказа команды в песочнице.
 *
 * Последняя строка stderr — не причина. `npm` и docker дописывают в конец подсказку
 * (`Run 'docker run --help' for more information`, `A complete log of this run can be found
 * in: …`), и в причине предпросмотра оказывалась именно она: «установка зависимостей не
 * прошла: Run 'docker run --help'…» выглядит как сломанная установка, хотя docker просто
 * отказался создать контейнер. Поэтому причиной становится последняя содержательная строка
 * с признаком отказа, а подсказки и хвосты логов отбрасываются.
 */

/** Строки, которые печатаются как подсказка и о самом отказе не сообщают ничего. */
const NOISE = [
  /^(?:see|run)\s+'?.*--help'?\s+for more information\.?$/i,
  /a complete log of this run can be found/i,
  /^to see the full (?:error|stack)/i,
];

/** Признаки причины: их печатают docker, npm и оболочка, когда команда действительно не прошла. */
const CAUSE =
  /(?:err!|fatal|fail(?:ed|ure)?|error|denied|not found|no such|cannot|can't|unable|invalid|EACCES|ENOENT|ETIMEDOUT|ECONNREFUSED|ENOTFOUND)/i;

export type CommandOutput = { stdout?: string; stderr?: string };

function meaningfulLines(output: CommandOutput) {
  return (output.stderr ?? "")
    .split("\n")
    .map(line => line.replace(/\r/g, "").trim())
    .filter(line => line.length > 0 && !NOISE.some(pattern => pattern.test(line)));
}

/** Причина отказа: последняя содержательная строка stderr, без подсказок и хвостов логов. */
export function failureLine(output: CommandOutput): string | undefined {
  const lines = meaningfulLines(output);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (CAUSE.test(lines[index])) return lines[index];
  }
  return lines.at(-1);
}
