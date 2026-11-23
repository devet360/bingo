package com.verity.platform.service;

import com.verity.platform.api.ApiExceptionHandler.DuplicateReferenceException;
import com.verity.platform.api.ApiExceptionHandler.IdempotencyConflictException;
import com.verity.platform.api.CreateVerificationRequest;
import com.verity.platform.api.VerificationResponse;
import com.verity.platform.api.VerificationPageResponse;
import com.verity.platform.domain.VerificationGate;
import com.verity.platform.domain.VerificationStatus;
import com.verity.platform.provider.ProviderAdapter;
import com.verity.platform.provider.ProviderRegistry;
import com.verity.platform.provider.ProviderUnavailableException;
import com.verity.platform.security.TenantPrincipal;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class VerificationService {
  private final JdbcTemplate jdbc;
  private final ProviderRegistry providers;

  public VerificationService(JdbcTemplate jdbc, ProviderRegistry providers) {
    this.jdbc = jdbc;
    this.providers = providers;
  }

  @Transactional
  public VerificationResponse create(
      TenantPrincipal tenant, String idempotencyKey, CreateVerificationRequest request) {
    byte[] requestFingerprint = sha256(canonicalRequest(request));
    var existingIdempotency = jdbc.query(
        "SELECT request_fingerprint, verification_id FROM idempotency_records WHERE project_id = ? AND idempotency_key = ? AND expires_at > now()",
        (rs, rowNum) -> new IdempotencyRow(rs.getBytes("request_fingerprint"), rs.getObject("verification_id", UUID.class)),
        tenant.projectId(), idempotencyKey);
    if (!existingIdempotency.isEmpty()) {
      var row = existingIdempotency.get(0);
      if (!MessageDigest.isEqual(row.fingerprint(), requestFingerprint)) throw new IdempotencyConflictException();
      if (row.verificationId() == null) throw new IllegalStateException("Idempotency record is incomplete");
      return find(tenant, row.verificationId()).orElseThrow();
    }

    UUID idempotencyId = UUID.randomUUID();
    List<UUID> inserted = jdbc.query(
        "INSERT INTO idempotency_records (id, project_id, idempotency_key, request_fingerprint) VALUES (?, ?, ?, ?) ON CONFLICT (project_id, idempotency_key) DO UPDATE SET id = EXCLUDED.id, request_fingerprint = EXCLUDED.request_fingerprint, verification_id = NULL, created_at = now(), expires_at = now() + INTERVAL '24 hours' WHERE idempotency_records.expires_at <= now() RETURNING id",
        (rs, rowNum) -> rs.getObject("id", UUID.class),
        idempotencyId, tenant.projectId(), idempotencyKey, requestFingerprint);
    if (inserted.isEmpty()) {
      var raced = jdbc.query(
          "SELECT request_fingerprint, verification_id FROM idempotency_records WHERE project_id = ? AND idempotency_key = ? AND expires_at > now()",
          (rs, rowNum) -> new IdempotencyRow(rs.getBytes("request_fingerprint"), rs.getObject("verification_id", UUID.class)),
          tenant.projectId(), idempotencyKey).stream().findFirst().orElseThrow();
      if (!MessageDigest.isEqual(raced.fingerprint(), requestFingerprint)) throw new IdempotencyConflictException();
      return find(tenant, raced.verificationId()).orElseThrow();
    }

    String normalizedReference = normalizeReference(request.reference());
    byte[] referenceFingerprint = sha256(normalizedReference);
    if (!jdbc.query(
        "SELECT id FROM verification_requests WHERE organization_id = ? AND provider_code = ? AND reference_fingerprint = ?",
        (rs, rowNum) -> rs.getObject("id", UUID.class),
        tenant.organizationId(), request.provider(), referenceFingerprint).isEmpty()) {
      throw new DuplicateReferenceException();
    }

    BigDecimal amount = request.expected() == null || request.expected().amount() == null
        ? null : new BigDecimal(request.expected().amount());
    String currency = request.expected() == null ? null : request.expected().currency();
    VerificationStatus status = VerificationStatus.UNSUPPORTED;
    String source = null;
    String errorCode = "PROVIDER_NOT_ENABLED";
    Instant checkedAt = null;

    Optional<ProviderAdapter> adapter = providers.find(request.provider());
    if (adapter.isPresent()) {
      var providerRequest = new ProviderAdapter.ProviderRequest(request.reference(), amount, currency, request.receiverAccountSuffix());
      try {
        var result = adapter.get().verify(providerRequest);
        status = VerificationGate.evaluate(providerRequest, result);
        source = result.source();
        errorCode = status == VerificationStatus.VERIFIED ? null : errorCodeFor(status);
        checkedAt = Instant.now();
      } catch (ProviderUnavailableException exception) {
        status = VerificationStatus.UNREACHABLE;
        errorCode = "PROVIDER_UNREACHABLE";
        checkedAt = Instant.now();
      }
    }

    UUID verificationId = UUID.randomUUID();
    try {
      jdbc.update(
          "INSERT INTO verification_requests (id, organization_id, project_id, provider_code, reference_fingerprint, expected_amount, expected_currency, status, source, error_code, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          verificationId, tenant.organizationId(), tenant.projectId(), request.provider(),
          referenceFingerprint, amount, currency, status.name(), source, errorCode, checkedAt);
    } catch (DataIntegrityViolationException exception) {
      throw new DuplicateReferenceException();
    }
    jdbc.update("UPDATE idempotency_records SET verification_id = ? WHERE id = ?", verificationId, idempotencyId);
    jdbc.update(
        "INSERT INTO audit_events (organization_id, actor_type, action, resource_type, resource_id, metadata) VALUES (?, 'api_key', 'verification.created', 'verification', ?, jsonb_build_object('provider', ?::text, 'status', ?::text))",
        tenant.organizationId(), verificationId, request.provider(), status.name());
    return find(tenant, verificationId).orElseThrow();
  }

  @Transactional(readOnly = true)
  public VerificationPageResponse list(
      TenantPrincipal tenant, int page, int size, String provider, VerificationStatus status) {
    int requestedSize = Math.min(size, 100);
    int offset = Math.multiplyExact(page, requestedSize);
    String statusValue = status == null ? null : status.name();
    var items = jdbc.query(
        "SELECT id, provider_code, status, source, error_code, created_at, checked_at FROM verification_requests WHERE project_id = ? AND (CAST(? AS varchar) IS NULL OR provider_code = ?) AND (CAST(? AS varchar) IS NULL OR status = ?) ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
        (rs, rowNum) -> response(rs), tenant.projectId(), provider, provider, statusValue, statusValue,
        requestedSize + 1, offset);
    boolean hasMore = items.size() > requestedSize;
    if (hasMore) items = items.subList(0, requestedSize);
    return new VerificationPageResponse(items, page, requestedSize, hasMore);
  }

  @Transactional(readOnly = true)
  public Optional<VerificationResponse> find(TenantPrincipal tenant, UUID id) {
    return jdbc.query(
        "SELECT id, provider_code, status, source, error_code, created_at, checked_at FROM verification_requests WHERE id = ? AND project_id = ?",
        (rs, rowNum) -> response(rs), id, tenant.projectId()).stream().findFirst();
  }

  private static VerificationResponse response(ResultSet rs) throws SQLException {
    var createdAt = rs.getTimestamp("created_at").toInstant();
    var checked = rs.getTimestamp("checked_at");
    return new VerificationResponse(
        rs.getObject("id", UUID.class), rs.getString("provider_code"),
        VerificationStatus.valueOf(rs.getString("status")), rs.getString("source"),
        rs.getString("error_code"), createdAt, checked == null ? null : checked.toInstant());
  }

  private static String canonicalRequest(CreateVerificationRequest request) {
    var expected = request.expected();
    return String.join("\n", request.provider(), normalizeReference(request.reference()),
        request.receiverAccountSuffix() == null ? "" : request.receiverAccountSuffix(),
        expected == null || expected.amount() == null ? "" : new BigDecimal(expected.amount()).stripTrailingZeros().toPlainString(),
        expected == null || expected.currency() == null ? "" : expected.currency());
  }

  private static String normalizeReference(String value) {
    return value.replaceAll("[^A-Za-z0-9]", "").toUpperCase();
  }

  private static byte[] sha256(String value) {
    try {
      return MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
    } catch (NoSuchAlgorithmException exception) {
      throw new IllegalStateException("SHA-256 is unavailable", exception);
    }
  }

  private static String errorCodeFor(VerificationStatus status) {
    return switch (status) {
      case PENDING -> "PROVIDER_PENDING";
      case NOT_FOUND -> "TRANSACTION_NOT_FOUND";
      case NOT_MATCHED -> "EXPECTATION_MISMATCH";
      case INVALID_INPUT -> "INVALID_INPUT";
      case MANUAL_REVIEW -> "VERIFICATION_REVIEW_REQUIRED";
      default -> "VERIFICATION_FAILED";
    };
  }

  private record IdempotencyRow(byte[] fingerprint, UUID verificationId) {}
}
