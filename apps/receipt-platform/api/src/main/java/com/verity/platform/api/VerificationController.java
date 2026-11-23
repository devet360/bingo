package com.verity.platform.api;

import com.verity.platform.security.TenantPrincipal;
import com.verity.platform.domain.VerificationStatus;
import com.verity.platform.service.VerificationService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.responses.ApiResponses;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Pattern;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@Tag(name = "Verifications", description = "Create and inspect tenant-scoped verification results")
@SecurityRequirement(name = "apiKeyBearer")
@RequestMapping("/v1/verifications")
@Validated
public class VerificationController {
  private final VerificationService service;

  public VerificationController(VerificationService service) {
    this.service = service;
  }

  @PostMapping
  @Operation(summary = "Create a verification", description = "Creates one idempotent verification record. Providers without a tested authoritative adapter return UNSUPPORTED.")
  @ApiResponses({
      @ApiResponse(responseCode = "201", description = "Verification accepted"),
      @ApiResponse(responseCode = "400", description = "Invalid request or missing idempotency key"),
      @ApiResponse(responseCode = "401", description = "Missing or invalid API key"),
      @ApiResponse(responseCode = "403", description = "API key lacks the required scope"),
      @ApiResponse(responseCode = "409", description = "Duplicate reference or idempotency conflict")
  })
  @ResponseStatus(HttpStatus.CREATED)
  @PreAuthorize("hasAuthority('SCOPE_verification:create')")
  public VerificationResponse create(
      @AuthenticationPrincipal TenantPrincipal tenant,
      @RequestHeader("Idempotency-Key") @Pattern(regexp = "[A-Za-z0-9._:-]{8,128}") String idempotencyKey,
      @Valid @RequestBody CreateVerificationRequest request) {
    return service.create(tenant, idempotencyKey, request);
  }

  @GetMapping
  @Operation(summary = "List verifications", description = "Returns a paginated, project-scoped list. Page numbers are zero-based and page size is capped at 100.")
  @ApiResponses({
      @ApiResponse(responseCode = "200", description = "Verification page returned"),
      @ApiResponse(responseCode = "401", description = "Missing or invalid API key"),
      @ApiResponse(responseCode = "403", description = "API key lacks the required scope")
  })
  @PreAuthorize("hasAuthority('SCOPE_verification:read')")
  public VerificationPageResponse list(
      @AuthenticationPrincipal TenantPrincipal tenant,
      @RequestParam(defaultValue = "0") @Min(0) @Max(1000000) int page,
      @RequestParam(defaultValue = "25") @Min(1) @Max(100) int size,
      @RequestParam(required = false) @Pattern(regexp = "[a-z0-9_-]{2,48}") String provider,
      @RequestParam(required = false) VerificationStatus status) {
    return service.list(tenant, page, size, provider, status);
  }

  @GetMapping("/{id}")
  @Operation(summary = "Get a verification", description = "Returns a verification only when it belongs to the API key's project.")
  @ApiResponses({
      @ApiResponse(responseCode = "200", description = "Verification found"),
      @ApiResponse(responseCode = "401", description = "Missing or invalid API key"),
      @ApiResponse(responseCode = "403", description = "API key lacks the required scope"),
      @ApiResponse(responseCode = "404", description = "Verification not found")
  })
  @PreAuthorize("hasAuthority('SCOPE_verification:read')")
  public VerificationResponse get(
      @AuthenticationPrincipal TenantPrincipal tenant, @PathVariable UUID id) {
    return service.find(tenant, id)
        .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Verification not found"));
  }
}
