package com.verity.platform.provider.cbe;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.net.URI;
import org.junit.jupiter.api.Test;

class CbeBranchAdapterTest {
  @Test
  void buildsOnlyTheFixedHttpsCbeEndpoint() {
    URI uri = CbeBranchAdapter.buildReceiptUri("FT26266 ZN54F", "23145909");
    assertThat(uri.getScheme()).isEqualTo("https");
    assertThat(uri.getHost()).isEqualTo("apps.cbe.com.et");
    assertThat(uri.getPort()).isEqualTo(100);
    assertThat(uri.getRawPath()).isEqualTo("/BranchReceipt/FT26266ZN54F&23145909");
    assertThatThrownBy(() -> CbeBranchAdapter.buildReceiptUri("abc", "1234"))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void onlyAcceptsTheExpectedMaskedReceiverSuffix() {
    assertThat(CbeBranchAdapter.receiverSuffixMatches("1****5909", "23145909")).isTrue();
    assertThat(CbeBranchAdapter.receiverSuffixMatches("1****9999", "23145909")).isFalse();
    assertThat(CbeBranchAdapter.receiverSuffixMatches("1****909", "23145909")).isFalse();
    assertThat(CbeBranchAdapter.receiverSuffixMatches(null, "23145909")).isFalse();
  }
}
