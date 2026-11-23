package com.verity.platform.domain;

import static org.assertj.core.api.Assertions.assertThat;

import com.verity.platform.provider.ProviderAdapter.ProviderRequest;
import com.verity.platform.provider.ProviderAdapter.ProviderResult;
import java.math.BigDecimal;
import java.util.Optional;
import org.junit.jupiter.api.Test;

class VerificationGateTest {
  private static ProviderRequest expected() {
    return new ProviderRequest("ABC123", new BigDecimal("125.00"), "ETB", null);
  }

  private static ProviderResult successful(boolean authoritative, String currency) {
    return new ProviderResult(
        "SUCCESS", "TEST_FIXTURE", authoritative, Optional.of(new BigDecimal("125.00")),
        Optional.ofNullable(currency), Optional.of("ABC123"));
  }

  @Test
  void requiresAuthoritativeSource() {
    assertThat(VerificationGate.evaluate(expected(), successful(false, "ETB")))
        .isEqualTo(VerificationStatus.MANUAL_REVIEW);
  }

  @Test
  void verifiesOnlyWhenEveryExpectationMatches() {
    assertThat(VerificationGate.evaluate(expected(), successful(true, "ETB")))
        .isEqualTo(VerificationStatus.VERIFIED);
    assertThat(VerificationGate.evaluate(expected(), successful(true, "USD")))
        .isEqualTo(VerificationStatus.NOT_MATCHED);
  }

  @Test
  void neverTreatsPendingAsSuccess() {
    var pending = new ProviderResult(
        "PENDING", "TEST_FIXTURE", true, Optional.empty(), Optional.empty(), Optional.of("ABC123"));
    assertThat(VerificationGate.evaluate(expected(), pending))
        .isEqualTo(VerificationStatus.PENDING);
  }

  @Test
  void normalizesReferenceSeparatorsAndFailsClosedOnUnknownStates() {
    var normalized = new ProviderResult(
        "SUCCESS", "TEST_FIXTURE", true, Optional.of(new BigDecimal("125.00")),
        Optional.of("ETB"), Optional.of("ABC-123"));
    var unknown = new ProviderResult(
        "UNKNOWN", "TEST_FIXTURE", true, Optional.empty(), Optional.empty(), Optional.empty());
    assertThat(VerificationGate.evaluate(expected(), normalized)).isEqualTo(VerificationStatus.VERIFIED);
    assertThat(VerificationGate.evaluate(expected(), unknown)).isEqualTo(VerificationStatus.MANUAL_REVIEW);
  }
}
