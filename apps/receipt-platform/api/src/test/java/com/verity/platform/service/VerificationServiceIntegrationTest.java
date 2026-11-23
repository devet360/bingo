package com.verity.platform.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.verity.platform.api.ApiExceptionHandler.DuplicateReferenceException;
import com.verity.platform.api.ApiExceptionHandler.IdempotencyConflictException;
import com.verity.platform.api.CreateVerificationRequest;
import com.verity.platform.domain.VerificationStatus;
import com.verity.platform.security.TenantPrincipal;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

@SpringBootTest
@Testcontainers(disabledWithoutDocker = true)
class VerificationServiceIntegrationTest {
  @Container
  private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:16-alpine");

  @DynamicPropertySource
  static void configureDatabase(DynamicPropertyRegistry properties) {
    properties.add("spring.datasource.url", POSTGRES::getJdbcUrl);
    properties.add("spring.datasource.username", POSTGRES::getUsername);
    properties.add("spring.datasource.password", POSTGRES::getPassword);
  }

  @Autowired
  private VerificationService service;

  @Autowired
  private JdbcTemplate jdbc;

  private TenantPrincipal firstProject;
  private TenantPrincipal secondProject;

  @BeforeEach
  void createProjects() {
    UUID organizationId = UUID.randomUUID();
    jdbc.update("INSERT INTO organizations (id, display_name) VALUES (?, ?)", organizationId, "Integration test");
    UUID firstProjectId = createProject(organizationId, "first");
    UUID secondProjectId = createProject(organizationId, "second");
    firstProject = new TenantPrincipal(organizationId, firstProjectId, Set.of("verification:create", "verification:read"));
    secondProject = new TenantPrincipal(organizationId, secondProjectId, Set.of("verification:create", "verification:read"));
  }

  @Test
  void idempotentCreatePersistsOneResultAndScopesReadsToProject() {
    var request = request("FT-2026-0001");

    var created = service.create(firstProject, "integration-idem-0001", request);
    var replayed = service.create(firstProject, "integration-idem-0001", request);

    assertThat(created.id()).isEqualTo(replayed.id());
    assertThat(created.status()).isEqualTo(VerificationStatus.UNSUPPORTED);
    assertThat(service.list(firstProject, 0, 25, null, null).data())
        .extracting(item -> item.id())
        .containsExactly(created.id());
    assertThat(service.list(secondProject, 0, 25, null, null).data()).isEmpty();
  }

  @Test
  void idempotencyKeyCannotBeReusedForDifferentRequestData() {
    service.create(firstProject, "integration-idem-0004", request("FT-2026-0004"));
    var changedRequest = new CreateVerificationRequest("unconfigured", "FT-2026-0004", null,
        new CreateVerificationRequest.Expected("126.00", "ETB"));

    assertThatThrownBy(() -> service.create(firstProject, "integration-idem-0004", changedRequest))
        .isInstanceOf(IdempotencyConflictException.class);
  }

  @Test
  void duplicateProviderReferenceIsRejectedAcrossProjectsInOneOrganization() {
    service.create(firstProject, "integration-idem-0002", request("FT-2026-0002"));

    assertThatThrownBy(() -> service.create(
        secondProject, "integration-idem-0003", request("FT-2026-0002")))
        .isInstanceOf(DuplicateReferenceException.class);
  }

  private UUID createProject(UUID organizationId, String name) {
    return jdbc.queryForObject(
        "INSERT INTO projects (organization_id, name, environment) VALUES (?, ?, 'test') RETURNING id",
        UUID.class, organizationId, name);
  }

  private static CreateVerificationRequest request(String reference) {
    return new CreateVerificationRequest("unconfigured", reference, null,
        new CreateVerificationRequest.Expected("125.00", "ETB"));
  }
}
