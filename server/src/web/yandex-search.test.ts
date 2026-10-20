import test from "node:test";
import assert from "node:assert/strict";
import { buildYandexSearchBody, parseYandexResponse, parseYandexXml, yandexSearchConfig } from "./yandex-search.js";

const XML = `<?xml version="1.0" encoding="utf-8"?>
<yandexsearch version="1.0">
  <response>
    <results>
      <grouping>
        <group>
          <doc>
            <url>https://nodejs.org/api/</url>
            <title>Node.js <hlword>API</hlword> documentation</title>
            <passages><passage>HTTP <hlword>документация</hlword> Node.js.</passage></passages>
          </doc>
        </group>
        <group>
          <doc>
            <url>https://fastify.dev/</url>
            <title><![CDATA[Fastify — документация]]></title>
            <passages><passage>Быстрый веб-фреймворк.</passage></passages>
          </doc>
        </group>
      </grouping>
    </results>
  </response>
</yandexsearch>`;

test("the request carries the query, the folder and string-encoded numbers", () => {
  const body = buildYandexSearchBody("fastify hooks", "b1gtests", { limit: 5, searchType: "SEARCH_TYPE_RU" });
  assert.equal(body.folderId, "b1gtests");
  assert.equal(body.query.queryText, "fastify hooks");
  assert.equal(body.query.searchType, "SEARCH_TYPE_RU");
  assert.equal(body.query.groupSpec.groupsOnPage, "5", "protobuf-JSON принимает числа строкой");
  assert.equal(body.query.page, "0");
});

test("the response is base64 XML inside rawData", () => {
  const rawData = Buffer.from(XML, "utf8").toString("base64");
  const results = parseYandexResponse({ rawData });
  assert.equal(results.length, 2);
  assert.equal(results[0]?.url, "https://nodejs.org/api/");
  assert.equal(results[0]?.title, "Node.js API documentation", "подсветка <hlword> не попадает в заголовок");
  assert.equal(results[0]?.snippet, "HTTP документация Node.js.");
  assert.equal(results[1]?.title, "Fastify — документация", "CDATA раскрывается");
});

test("plain XML satisfies the same parser, and an empty response is honest", () => {
  assert.equal(parseYandexResponse({ rawData: XML }).length, 2);
  assert.deepEqual(parseYandexResponse({}), []);
  assert.deepEqual(parseYandexResponse(null), []);
  assert.deepEqual(parseYandexXml("<yandexsearch/>"), []);
});

test("a document without a url is not a result", () => {
  const broken = "<grouping><group><doc><title>Без ссылки</title></doc></group></grouping>";
  assert.deepEqual(parseYandexXml(broken), []);
});

test("the provider reports itself as unconfigured until both values are present", () => {
  const previousKey = process.env.YANDEX_SEARCH_API_KEY;
  const previousFolder = process.env.YANDEX_SEARCH_FOLDER_ID;
  const previousShared = process.env.YANDEX_FOLDER_ID;
  try {
    delete process.env.YANDEX_SEARCH_API_KEY;
    delete process.env.YANDEX_SEARCH_FOLDER_ID;
    delete process.env.YANDEX_FOLDER_ID;
    assert.equal(yandexSearchConfig(), null);
    process.env.YANDEX_SEARCH_API_KEY = "Aq-test";
    assert.equal(yandexSearchConfig(), null, "одного ключа без каталога недостаточно");
    process.env.YANDEX_FOLDER_ID = "b1gshared";
    assert.deepEqual(yandexSearchConfig(), { apiKey: "Aq-test", folderId: "b1gshared" }, "общий каталог платформы подходит");
    process.env.YANDEX_SEARCH_FOLDER_ID = "b1gsearch";
    assert.equal(yandexSearchConfig()?.folderId, "b1gsearch", "отдельный каталог важнее общего");
  } finally {
    for (const [name, value] of [
      ["YANDEX_SEARCH_API_KEY", previousKey],
      ["YANDEX_SEARCH_FOLDER_ID", previousFolder],
      ["YANDEX_FOLDER_ID", previousShared],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
