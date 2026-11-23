package com.verity.platform.telegram;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HexFormat;
import java.util.Map;
import java.util.TreeMap;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.Test;
import org.springframework.web.server.ResponseStatusException;

class TelegramInitDataVerifierTest {
  private static final String TOKEN = "123456:example-not-a-real-token";

  @Test
  void acceptsAValidFreshTelegramPayload() throws Exception {
    var verifier = new TelegramInitDataVerifier(TOKEN, new ObjectMapper());
    var result = verifier.verify(payload(System.currentTimeMillis() / 1000));

    assertEquals(123456789L, result.id());
    assertEquals("Ari", result.firstName());
    assertEquals("verity_user", result.username());
  }

  @Test
  void rejectsChangedPayloadAfterSigning() throws Exception {
    var verifier = new TelegramInitDataVerifier(TOKEN, new ObjectMapper());
    String valid = payload(System.currentTimeMillis() / 1000);

    assertThrows(ResponseStatusException.class, () -> verifier.verify(valid.replace("Ari", "Eve")));
  }

  @Test
  void rejectsExpiredPayload() throws Exception {
    var verifier = new TelegramInitDataVerifier(TOKEN, new ObjectMapper());
    String expired = payload(System.currentTimeMillis() / 1000 - 600);

    assertThrows(ResponseStatusException.class, () -> verifier.verify(expired));
  }

  private static String payload(long authDate) throws Exception {
    Map<String, String> fields = new TreeMap<>();
    fields.put("auth_date", Long.toString(authDate));
    fields.put("query_id", "AAEAAAE");
    fields.put("user", "{\"id\":123456789,\"first_name\":\"Ari\",\"username\":\"verity_user\"}");
    String checkString = fields.entrySet().stream().map(entry -> entry.getKey() + "=" + entry.getValue()).reduce((a, b) -> a + "\n" + b).orElseThrow();
    byte[] secret = hmac("WebAppData".getBytes(StandardCharsets.UTF_8), TOKEN.getBytes(StandardCharsets.UTF_8));
    String hash = HexFormat.of().formatHex(hmac(secret, checkString.getBytes(StandardCharsets.UTF_8)));
    fields.put("hash", hash);
    return fields.entrySet().stream()
        .map(entry -> URLEncoder.encode(entry.getKey(), StandardCharsets.UTF_8) + "=" + URLEncoder.encode(entry.getValue(), StandardCharsets.UTF_8))
        .reduce((a, b) -> a + "&" + b)
        .orElseThrow();
  }

  private static byte[] hmac(byte[] key, byte[] value) throws Exception {
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(key, "HmacSHA256"));
    return mac.doFinal(value);
  }
}
