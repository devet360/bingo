package com.verity.platform.telegram;

import com.fasterxml.jackson.databind.JsonNode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;
import org.springframework.web.server.ResponseStatusException;

@Service
public class TelegramBotService {
  private final String botToken;
  private final String webhookSecret;
  private final String miniAppUrl;
  private final RestClient telegram = RestClient.builder().baseUrl("https://api.telegram.org").build();

  public TelegramBotService(
      @Value("${telegram.bot-token:}") String botToken,
      @Value("${telegram.webhook-secret:}") String webhookSecret,
      @Value("${telegram.mini-app-url:}") String miniAppUrl) {
    this.botToken = botToken;
    this.webhookSecret = webhookSecret;
    this.miniAppUrl = miniAppUrl;
  }

  public void acceptUpdate(String suppliedSecret, JsonNode update) {
    if (webhookSecret == null || webhookSecret.isBlank()) {
      throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Telegram webhook is not configured");
    }
    if (!constantTimeEquals(webhookSecret, suppliedSecret)) {
      throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid webhook secret");
    }
    if (botToken == null || botToken.isBlank()) {
      throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Telegram bot is not configured");
    }

    JsonNode message = update.path("message");
    String text = message.path("text").asText("").trim();
    if (!message.has("chat") || text.isEmpty() || text.length() > 4096) return;
    String chatId = message.path("chat").path("id").asText("");
    if (!chatId.matches("-?[0-9]{1,24}")) return;

    if (text.matches("(?i)^/start(?:@\\w+)?(?:\\s+.*)?$")) {
      sendStart(chatId);
    } else if (text.matches("(?i)^/help(?:@\\w+)?$")) {
      sendText(chatId, "Use /start to open Verity. Receipt text and screenshots alone never verify a payment.");
    } else if (text.matches("(?i)^/(?:verify|status)(?:@\\w+)?(?:\\s+.*)?$")) {
      sendText(chatId, "Account linking and authenticated verification actions are not enabled yet. No payment status was checked.");
    } else {
      sendText(chatId, "I can open the Verity Mini App with /start. Use /help for guidance.");
    }
  }

  private void sendStart(String chatId) {
    if (miniAppUrl == null || miniAppUrl.isBlank() || !miniAppUrl.startsWith("https://")) {
      sendText(chatId, "Verity is not configured with a secure Mini App URL yet. No account was linked.");
      return;
    }
    Map<String, Object> button = Map.of(
        "text", "Open Verity",
        "web_app", Map.of("url", miniAppUrl));
    Map<String, Object> keyboard = Map.of("inline_keyboard", List.of(List.of(button)));
    telegram.post()
        .uri("/bot{token}/sendMessage", botToken)
        .body(Map.of(
            "chat_id", chatId,
            "text", "Welcome to Verity. Open the Mini App to continue. Telegram identity is verified server-side.",
            "reply_markup", keyboard))
        .retrieve()
        .toBodilessEntity();
  }

  private void sendText(String chatId, String text) {
    telegram.post()
        .uri("/bot{token}/sendMessage", botToken)
        .body(Map.of("chat_id", chatId, "text", text))
        .retrieve()
        .toBodilessEntity();
  }

  private static boolean constantTimeEquals(String expected, String supplied) {
    if (expected == null || supplied == null) return false;
    return MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8), supplied.getBytes(StandardCharsets.UTF_8));
  }
}
