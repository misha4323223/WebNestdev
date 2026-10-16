import test from "node:test";
import assert from "node:assert/strict";
import { describePreviewHosts, previewHostLabel, previewHostTarget, previewPublicDomain, previewPublicUrl } from "./preview-host.js";

const KEY = "PREVIEW_PUBLIC_DOMAIN";

function withDomain(value: string | undefined, body: () => void) {
  const before = process.env[KEY];
  if (value === undefined) delete process.env[KEY];
  else process.env[KEY] = value;
  try {
    body();
  } finally {
    if (before === undefined) delete process.env[KEY];
    else process.env[KEY] = before;
  }
}

test("без PREVIEW_PUBLIC_DOMAIN публичных адресов нет", () => {
  withDomain(undefined, () => {
    assert.equal(previewPublicDomain(), "");
    assert.equal(previewPublicUrl("p1"), "");
    assert.equal(previewHostTarget("p1.preview.nestdev.ru"), null);
    assert.match(describePreviewHosts(), /выключены/);
  });
});

test("домен принимается в том виде, в каком его пишут в .env", () => {
  // Схема, порт и слэш на конце — обычные способы записать адрес; сравнивать их с именем хоста нельзя.
  for (const value of ["preview.nestdev.ru", "https://preview.nestdev.ru", "https://preview.nestdev.ru/", "PREVIEW.NESTDEV.RU:443", ".preview.nestdev.ru"]) {
    withDomain(value, () => assert.equal(previewPublicDomain(), "preview.nestdev.ru", value));
  }
});

test("значение, которое не является доменом, выключает адреса, а не подставляется в сравнение хостов", () => {
  for (const value of ["*", "*.preview.nestdev.ru", "https://", " ", "preview .nestdev.ru"]) {
    withDomain(value, () => assert.equal(previewPublicDomain(), "", value));
  }
});

test("адресом предпросмотра считается ровно один уровень под доменом", () => {
  withDomain("preview.nestdev.ru", () => {
    assert.deepEqual(previewHostTarget("3f9c1b2a-1c2b-4d5e-8f90-abcdef012345.preview.nestdev.ru"), {
      projectId: "3f9c1b2a-1c2b-4d5e-8f90-abcdef012345",
      host: "3f9c1b2a-1c2b-4d5e-8f90-abcdef012345.preview.nestdev.ru",
    });
    // Порт в заголовке Host и регистр — не часть имени проекта.
    assert.equal(previewHostTarget("p1.PREVIEW.NESTDEV.RU:8443")?.projectId, "p1");
    // Сам домен предпросмотра, два уровня и чужой домен проектом не являются: иначе подстановочная
    // DNS-запись превращала бы в проект любой чужой поддомен.
    assert.equal(previewHostTarget("preview.nestdev.ru"), null);
    assert.equal(previewHostTarget("a.b.preview.nestdev.ru"), null);
    assert.equal(previewHostTarget("p1.preview.nestdev.ru.evil.example"), null);
    assert.equal(previewHostTarget("p1.preview.other.example"), null);
    assert.equal(previewHostTarget(undefined), null);
  });
});

test("метка проекта — это его идентификатор, приведённый к виду DNS-метки", () => {
  assert.equal(previewHostLabel("3F9C1B2A-1C2B-4D5E-8F90-ABCDEF012345"), "3f9c1b2a-1c2b-4d5e-8f90-abcdef012345");
  for (const value of ["", "-leading", "with space", "with/slash", "a".repeat(64), "dot.name"]) {
    assert.equal(previewHostLabel(value), "", value);
  }
});

test("публичный адрес собирается из домена и идентификатора проекта", () => {
  withDomain("preview.nestdev.ru", () => {
    assert.equal(previewPublicUrl("p1"), "https://p1.preview.nestdev.ru");
    assert.equal(previewPublicUrl("не проект"), "");
    assert.match(describePreviewHosts(), /preview\.nestdev\.ru/);
  });
});
