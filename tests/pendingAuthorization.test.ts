import test from "node:test";
import assert from "node:assert";
import {
  accountLabel,
  buildPendingAuthorizationMessages,
  canConfirmAuthorization,
  nextPendingRequest,
  shouldRefreshPending,
  summarizeNotes,
  type PendingAuthorizationRequest,
} from "../src/utils/pendingAuthorization.ts";

function makeRequest(overrides: Partial<PendingAuthorizationRequest> = {}): PendingAuthorizationRequest {
  return {
    accountKey: "google-sub-123",
    accountEmail: "otra.cuenta@example.com",
    requestId: "req-1",
    noteCount: 2,
    notes: [{ noteId: "note-1", name: "Diario.txt" }, { noteId: "note-2", name: "Ideas.md" }],
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

test("AUD-001 consentimiento: la solicitud identifica la cuenta de destino y el número exacto de notas", () => {
  const messages = buildPendingAuthorizationMessages(makeRequest());

  assert.match(messages.destination, /otra\.cuenta@example\.com/);
  assert.match(messages.summary, /^2 notas/);
  assert.match(messages.warning, /otra\.cuenta@example\.com/);
  assert.match(messages.warning, /no se autorizan automáticamente/);
});

test("AUD-001 consentimiento: usa singular cuando solo hay una nota", () => {
  const messages = buildPendingAuthorizationMessages(
    makeRequest({ noteCount: 1, notes: [{ noteId: "one", name: "Única.txt" }] })
  );

  assert.match(messages.summary, /^1 nota /);
  assert.match(messages.warning, /esta nota/);
});

test("AUD-001 consentimiento: sin correo se muestra la clave estable de la cuenta", () => {
  const request = makeRequest({ accountEmail: null });

  assert.strictEqual(accountLabel(request), "google-sub-123");
  assert.match(buildPendingAuthorizationMessages(request).destination, /google-sub-123/);
});

test("AUD-001 consentimiento: la lista de notas se resume sin perder la cuenta total", () => {
  const notes = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt", "f.txt", "g.txt", "h.txt"];

  assert.strictEqual(summarizeNotes(["a.txt", "b.txt"]), "a.txt, b.txt");
  assert.strictEqual(summarizeNotes(notes), "a.txt, b.txt, c.txt, d.txt, e.txt, f.txt y 2 notas más");
  assert.strictEqual(summarizeNotes([]), "");
});

test("AUD-001 consentimiento: no se puede confirmar sin solicitud ni mientras se procesa", () => {
  const request = makeRequest();

  assert.strictEqual(canConfirmAuthorization(null, false), false);
  assert.strictEqual(canConfirmAuthorization(request, true), false);
  assert.strictEqual(canConfirmAuthorization(request, false), false);
  assert.strictEqual(canConfirmAuthorization(request, false, ["note-1"]), true);
  assert.strictEqual(canConfirmAuthorization(request, false, ["note-1", "note-1"]), false);
  assert.strictEqual(canConfirmAuthorization(request, false, ["unknown"]), false);
  assert.strictEqual(
    canConfirmAuthorization(makeRequest({ noteCount: 0, notes: [] }), false),
    false,
    "Una solicitud vacía nunca debe poder autorizarse"
  );
});

test("AUD-001 consentimiento: una solicitud descartada no reaparece, pero un conjunto nuevo sí", () => {
  const dismissed = new Set<string>(["req-1"]);
  const original = makeRequest();

  assert.strictEqual(nextPendingRequest(original, dismissed), null);
  assert.strictEqual(nextPendingRequest(null, dismissed), null);

  const changedSet = makeRequest({ requestId: "req-2", noteCount: 3, notes: [
    { noteId: "one", name: "Uno.txt" }, { noteId: "two", name: "Dos.txt" }, { noteId: "three", name: "Tres.txt" },
  ] });
  assert.deepStrictEqual(nextPendingRequest(changedSet, dismissed), changedSet);
});

test("AUD-001 consentimiento: solo se refresca la solicitud cuando el backend la señala", () => {
  assert.strictEqual(shouldRefreshPending({ pending_authorization: true }), true);
  assert.strictEqual(shouldRefreshPending({ pending_authorization: false }), false);
  assert.strictEqual(shouldRefreshPending({}), false);
  assert.strictEqual(shouldRefreshPending(null), false);
  assert.strictEqual(shouldRefreshPending(undefined), false);
});
