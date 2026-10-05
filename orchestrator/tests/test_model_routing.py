"""Provider model selection rules for translation requests."""

import unittest
from unittest.mock import patch

from app.core.adapters.llm.openai_compatible import OpenAICompatible


class ModelRoutingTests(unittest.TestCase):
    def adapter(self, **spec):
        return OpenAICompatible(
            "test-provider",
            {"base_url": "https://example.test/v1", **spec},
            {
                "request_timeout_s": 10,
                "models_timeout_s": 3,
                "temperature": 0.2,
                "max_output_tokens": 128,
            },
            expose_upstream_errors=False,
        )

    def test_general_provider_omits_model_when_request_does_not_choose_one(self):
        self.assertIsNone(self.adapter().resolve_openai_model(None))

    def test_route_provider_uses_auto_when_request_does_not_choose_one(self):
        self.assertEqual(
            self.adapter(model_policy="auto").resolve_openai_model(None), "auto"
        )

    def test_explicit_model_still_wins_over_provider_policy(self):
        self.assertEqual(
            self.adapter(model_policy="auto").resolve_openai_model("custom-model"),
            "custom-model",
        )


class ChatPayloadModelRoutingTests(unittest.IsolatedAsyncioTestCase):
    class Response:
        status_code = 200
        content = b'{"choices":[{"message":{"content":"ok"}}]}'
        text = ""

        def json(self):
            return {"choices": [{"message": {"content": "ok"}}]}

    class Client:
        def __init__(self):
            self.payload = None

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return None

        async def post(self, _url, *, headers, json):
            self.payload = json
            return ChatPayloadModelRoutingTests.Response()

    def adapter(self, **spec):
        return OpenAICompatible(
            "test-provider",
            {"base_url": "https://example.test/v1", **spec},
            {
                "request_timeout_s": 10,
                "models_timeout_s": 3,
                "temperature": 0.2,
                "max_output_tokens": 128,
            },
            expose_upstream_errors=False,
        )

    async def test_general_provider_omits_model_from_chat_payload(self):
        client = self.Client()
        with patch("app.core.adapters.llm.openai_compatible.httpx.AsyncClient", return_value=client):
            result = [
                piece
                async for piece in self.adapter().chat(
                    model=None, system="translate", messages=[], stream=False
                )
            ]
        self.assertEqual(result, ["ok"])
        self.assertNotIn("model", client.payload)

    async def test_route_provider_sends_auto_in_chat_payload(self):
        client = self.Client()
        with patch("app.core.adapters.llm.openai_compatible.httpx.AsyncClient", return_value=client):
            [
                piece
                async for piece in self.adapter(model_policy="auto").chat(
                    model=None, system="translate", messages=[], stream=False
                )
            ]
        self.assertEqual(client.payload["model"], "auto")


if __name__ == "__main__":
    unittest.main()
