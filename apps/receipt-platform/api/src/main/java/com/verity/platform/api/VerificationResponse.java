package com.verity.platform.api;

import com.verity.platform.domain.VerificationStatus;
import java.time.Instant;
import java.util.UUID;

public record VerificationResponse(
    UUID id,
    String provider,
    VerificationStatus status,
    String source,
    String errorCode,
    Instant createdAt,
    Instant checkedAt) {}
