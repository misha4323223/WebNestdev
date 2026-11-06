import assert from "node:assert/strict";
import test from "node:test";
import { previewDoorKey, previewDoorToken, previewDoorTokenValid } from "./door-token.js";

/**
 * Токен внутреннего канала двери: он выводится из ключа шифрования, который оба процесса получают
 * из окружения. Тест держит три вещи, от которых зависит работа отдельного процесса двери: токен
 * детерминирован (иначе дверь и API не договорятся), он не совпадает с ключом (иначе утечка
 * заголовка дала бы ключ расшифровки секретов) и сверка не пропускает чужой/пустой заголовок.
 */

const KEY = "a".repeat(64);

function withKey<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.WEBNESTDEV_ENCRYPTION_KEY;
  if (value === undefined) delete process.env.WEBNESTDEV_ENCRYPTION_KEY;
  else process.env.WEBNESTDEV_ENCRYPTION_KEY = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.WEBNESTDEV_ENCRYPTION_KEY;
    else process.env.WEBNESTDEV_ENCRYPTION_KEY = previous;
  }
}

test("токен детерминирован и не равен ключу шифрования", () => {
  const first = withKey(KEY, () => previewDoorToken());
  const second = withKey(KEY, () => previewDoorToken());
  assert.equal(typeof first, "string");
  assert.equal(first, second);
  assert.notEqual(first, KEY);
  assert.match(first ?? "", /^[a-f0-9]{64}$/);
});

test("другой ключ даёт другой токен: смена ключа закрывает старый канал", () => {
  const first = withKey(KEY, () => previewDoorToken());
  const other = withKey("b".repeat(64), () => previewDoorToken());
  assert.notEqual(first, other);
});

test("без ключа токена нет, и маршрут должен отвечать 503, а не пускать", () => {
  withKey(undefined, () => {
    assert.equal(previewDoorKey(), null);
    assert.equal(previewDoorToken(), null);
    assert.equal(previewDoorTokenValid("Bearer anything", null), false);
  });
});

test("сверка заголовка: свой токен проходит, чужой и пустой — нет", () => {
  withKey(KEY, () => {
    const token = previewDoorToken();
    assert.equal(previewDoorTokenValid("Bearer " + token), true);
    assert.equal(previewDoorTokenValid("bearer " + token), true);
    assert.equal(previewDoorTokenValid("Bearer " + "c".repeat(64)), false);
    assert.equal(previewDoorTokenValid("Bearer"), false);
    assert.equal(previewDoorTokenValid(undefined), false);
    assert.equal(previewDoorTokenValid("Basic " + token), false);
  });
});
