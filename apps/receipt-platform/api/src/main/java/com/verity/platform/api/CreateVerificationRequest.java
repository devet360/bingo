package com.verity.platform.api;

import com.fasterxml.jackson.annotation.JsonIgnore;
import jakarta.validation.Valid;
import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

public record CreateVerificationRequest(
    @NotBlank @Pattern(regexp = "[a-z0-9_-]{2,48}") String provider,
    @NotBlank @Size(max = 128) @Pattern(regexp = "[A-Za-z0-9][A-Za-z0-9 ._/-]{2,127}") String reference,
    @Pattern(regexp = "[0-9]{8}") String receiverAccountSuffix,
    @Valid Expected expected) {
  @JsonIgnore
  @AssertTrue(message = "Reference must contain at least 3 alphanumeric characters")
  public boolean isReferenceInputValid() {
    return reference != null && reference.replaceAll("[^A-Za-z0-9]", "").length() >= 3;
  }

  @JsonIgnore
  @AssertTrue(message = "CBE requires the last 8 digits of the receiving account; other providers must omit this field")
  public boolean isReceiverAccountInputValid() {
    return "cbe".equals(provider)
        ? receiverAccountSuffix != null && receiverAccountSuffix.matches("[0-9]{8}")
        : receiverAccountSuffix == null;
  }

  public record Expected(
      @Pattern(regexp = "(?:0|[1-9][0-9]{0,14})(?:\\.[0-9]{1,4})?") String amount,
      @Pattern(regexp = "[A-Z]{3}") String currency) {}
}
