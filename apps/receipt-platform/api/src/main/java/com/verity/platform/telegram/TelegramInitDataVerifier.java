package com.verity.platform.telegram;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Map;
import java.util.TreeMap;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

@Service
public class TelegramInitDataVerifier {
  private static final Duration MAX_AGE = Duration.ofMinutes(5);
  private static final Duration FUTURE_TOLERANCE = Duration.ofSeconds(30);
  private final String botToken;
  private final ObjectMapper objectMapper;

  public TelegramInitDataVerifier(
      @Value("${telegram.bot-token:}") String botToken,
      ObjectMapper objectMapper) {
    this.botToken = botToken;
    this.objectMapper = objectMapper;
  }

  public TelegramIdentity verify(String initData) {
    if (botToken == null || botToken.isBlank()) {
      throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Telegram identity validation is not configured");
    }
    if (initData == null || initData.isBlank() || initData.length() > 16_384) {
      throw unauthorized();
    }

    Map<String, String> fields = parse(initData);
    String suppliedHash = fields.remove("hash");
    if (suppliedHash == null || !suppliedHash.matches("[a-fA-F0-9]{64}")) {
      throw unauthorized();
    }

    String authDateText = fields.get("auth_date");
    String userJson = fields.get("user");
    if (authDateText == null || userJson == null) throw unauthorized();

    String checkString = fields.entrySet().stream()
        .map(entry -> entry.getKey() + "=" + entry.getValue())
        .reduce((left, right) -> left + "\n" + right)
        .orElseThrow(TelegramInitDataVerifier::unauthorized);

    byte[] secretKey = hmac("WebAppData".getBytes(StandardCharsets.UTF_8), botToken.getBytes(StandardCharsets.UTF_8));
    byte[] expectedHash = hmac(secretKey, checkString.getBytes(StandardCharsets.UTF_8));
    byte[] actualHash;
    try {
      actualHash = HexFormat.of().parseHex(suppliedHash);
    } catch (IllegalArgumentException exception) {
      throw unauthorized();
    }
    if (!MessageDigest.isEqual(expectedHash, actualHash)) throw unauthorized();

    long authEpoch;
    try {
      authEpoch = Long.parseLong(authDateText);
    } catch (NumberFormatException exception) {
      throw unauthorized();
    }
    Instant now = Instant.now();
    Instant issuedAt = Instant.ofEpochSecond(authEpoch);
    if (issuedAt.isBefore(now.minus(MAX_AGE)) || issuedAt.isAfter(now.plus(FUTURE_TOLERANCE))) {
      throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Telegram launch data is expired");
    }

    try {
      JsonNode user = objectMapper.readTree(userJson);
      long id = user.path("id").asLong(0);
      String firstName = user.path("first_name").asText("");
      if (id <= 0 || firstName.isBlank()) throw unauthorized();
      return new TelegramIdentity(
          id,
          firstName,
          user.path("last_name").asText(""),
          user.path("username").asText(""),
          user.path("language_code").asText(""),
          issuedAt);
    } catch (ResponseStatusException exception) {
      throw exception;
    } catch (Exception exception) {
      throw unauthorized();
    }
  }

  private static Map<String, String> parse(String initData) {
    Map<String, String> fields = new TreeMap<>();
    try {
      for (String pair : initData.split("&")) {
        int separator = pair.indexOf('=');
        if (separator <= 0) throw unauthorized();
        String key = URLDecoder.decode(pair.substring(0, separator), StandardCharsets.UTF_8);
        String value = URLDecoder.decode(pair.substring(separator + 1), StandardCharsets.UTF_8);
        if (key.isBlank() || fields.putIfAbsent(key, value) != null) throw unauthorized();
      }
    } catch (IllegalArgumentException exception) {
      throw unauthorized();
    }
    return fields;
  }

  private static byte[] hmac(byte[] key, byte[] value) {
    try {
      Mac mac = Mac.getInstance("HmacSHA256");
      mac.init(new SecretKeySpec(key, "HmacSHA256"));
      return mac.doFinal(value);
    } catch (Exception exception) {
      throw new IllegalStateException("HMAC-SHA256 is unavailable", exception);
    }
  }

  private static ResponseStatusException unauthorized() {
    return new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid Telegram launch data");
  }

  public record TelegramIdentity(long id, String firstName, String lastName, String username, String languageCode, Instant issuedAt) {}
}
