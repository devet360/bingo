package com.verity.platform.telegram;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/telegram")
public class TelegramController {
  private final TelegramInitDataVerifier verifier;
  private final TelegramBotService bot;

  public TelegramController(TelegramInitDataVerifier verifier, TelegramBotService bot) {
    this.verifier = verifier;
    this.bot = bot;
  }

  @PostMapping("/mini-app/auth")
  public TelegramInitDataVerifier.TelegramIdentity validateMiniAppIdentity(
      @Valid @RequestBody InitDataRequest request) {
    return verifier.verify(request.initData());
  }

  @PostMapping("/webhook")
  public ResponseEntity<Void> receiveBotUpdate(
      @RequestHeader(name = "X-Telegram-Bot-Api-Secret-Token", required = false) String secret,
      @RequestBody JsonNode update) {
    bot.acceptUpdate(secret, update);
    return ResponseEntity.ok().build();
  }

  public record InitDataRequest(@NotBlank @Size(max = 16_384) String initData) {}
}
