import { Api, HttpError } from "@grammyjs/grammy";
import type { ApiCallFn, CallData } from "@grammyjs/grammy";
import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { autoRetry } from "../src/mod.ts";

type ResponseParameters = {
    migrate_to_chat_id?: number;
    retry_after?: number;
};

function callData(
    chatId: number = 1,
): Extract<CallData, { method: "sendMessage" }> {
    return {
        method: "sendMessage",
        payload: { chat_id: chatId, text: "test" },
    };
}

function success() {
    return { ok: true as const, result: {} };
}

function failure(
    errorCode: number,
    parameters: ResponseParameters = {},
) {
    return {
        ok: false as const,
        error_code: errorCode,
        description: "test error",
        parameters,
    };
}

function apiCall(
    fn: (data: CallData, signal?: AbortSignal) => unknown | Promise<unknown>,
): ApiCallFn {
    return (async (data, signal) => await fn(data, signal)) as ApiCallFn;
}

function nextTurn() {
    return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

Deno.test("installs on the grammY 2.0 API", () => {
    const api = new Api("test-token");
    api.transform(autoRetry());
});

Deno.test("passes successful responses through unchanged", async () => {
    const data = callData();
    const response = success();
    let received: CallData | undefined;
    const prev = apiCall((next) => {
        received = next;
        return response;
    });

    const result = await autoRetry()(prev, data);

    assertStrictEquals(result, response);
    assertStrictEquals(received, data);
});

Deno.test("retries rate-limited requests", async () => {
    const responses = [failure(429, { retry_after: 0 }), success()];
    let calls = 0;
    const prev = apiCall(() => responses[calls++]);

    const result = await autoRetry()(prev, callData());

    assertStrictEquals(result, responses[1]);
    assertStrictEquals(calls, 2);
});

Deno.test("does not retry delays above maxDelaySeconds", async () => {
    const response = failure(429, { retry_after: 10 });
    let calls = 0;
    const prev = apiCall(() => {
        calls++;
        return response;
    });

    const result = await autoRetry({ maxDelaySeconds: 5 })(prev, callData());

    assertStrictEquals(result, response);
    assertStrictEquals(calls, 1);
});

Deno.test("honours maxRetryAttempts", async () => {
    const response = failure(429, { retry_after: 0 });
    let calls = 0;
    const prev = apiCall(() => {
        calls++;
        return response;
    });

    const result = await autoRetry({ maxRetryAttempts: 1 })(prev, callData());

    assertStrictEquals(result, response);
    assertStrictEquals(calls, 2);
});

Deno.test("retries chat migrations with the new chat ID", async () => {
    const original = callData(-1);
    const calls: CallData[] = [];
    const prev = apiCall((data) => {
        calls.push(data);
        return calls.length === 1
            ? failure(400, { migrate_to_chat_id: -2 })
            : success();
    });

    await autoRetry()(prev, original);

    assertStrictEquals(calls.length, 2);
    assertStrictEquals(calls[0], original);
    assertEquals(calls[1], callData(-2));
    assertEquals(original, callData(-1));
});

Deno.test("can rethrow chat migration errors", async () => {
    const response = failure(400, { migrate_to_chat_id: -2 });
    let calls = 0;
    const prev = apiCall(() => {
        calls++;
        return response;
    });

    const result = await autoRetry({ rethrowChatMigrationErrors: true })(
        prev,
        callData(-1),
    );

    assertStrictEquals(result, response);
    assertStrictEquals(calls, 1);
});

Deno.test("can rethrow internal server errors", async () => {
    const response = failure(500);
    let calls = 0;
    const prev = apiCall(() => {
        calls++;
        return response;
    });

    const result = await autoRetry({ rethrowInternalServerErrors: true })(
        prev,
        callData(),
    );

    assertStrictEquals(result, response);
    assertStrictEquals(calls, 1);
});

Deno.test("can rethrow HTTP errors", async () => {
    const error = new HttpError("network failed", new Error("test"));
    let calls = 0;
    const prev = apiCall(() => {
        calls++;
        throw error;
    });

    const thrown = await assertRejects(
        () => autoRetry({ rethrowHttpErrors: true })(prev, callData()),
    );
    assertStrictEquals(thrown, error);
    assertStrictEquals(calls, 1);
});

Deno.test("aborts while backing off after server errors", async () => {
    const controller = new AbortController();
    const prev = apiCall(() => failure(500));
    const result = autoRetry()(prev, callData(), controller.signal);
    await nextTurn();

    controller.abort();

    await assertRejects(
        () => result,
        Error,
        "Request aborted while waiting between retries",
    );
});

Deno.test("aborts while backing off after HTTP errors", async () => {
    const controller = new AbortController();
    const prev = apiCall(() => {
        throw new HttpError("network failed", new Error("test"));
    });
    const result = autoRetry()(prev, callData(), controller.signal);
    await nextTurn();

    controller.abort();

    await assertRejects(
        () => result,
        Error,
        "Request aborted while waiting between retries",
    );
});
