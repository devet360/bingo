package com.verity.platform.api;

import java.net.URI;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import jakarta.validation.ConstraintViolationException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
public class ApiExceptionHandler {
  @ExceptionHandler(MethodArgumentNotValidException.class)
  ProblemDetail invalidRequest(MethodArgumentNotValidException exception) {
    var problem = ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, "Request validation failed.");
    problem.setType(URI.create("https://docs.verity.example/errors/invalid_request"));
    problem.setTitle("Invalid request");
    problem.setProperty("code", "INVALID_INPUT");
    problem.setProperty("fields", exception.getBindingResult().getFieldErrors().stream()
        .map(error -> Map.of("field", error.getField(), "message", "Value is invalid"))
        .toList());
    return problem;
  }

  @ExceptionHandler(ConstraintViolationException.class)
  ProblemDetail invalidParameter() {
    var problem = ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, "A request parameter or header is invalid.");
    problem.setProperty("code", "INVALID_INPUT");
    return problem;
  }

  @ExceptionHandler(AccessDeniedException.class)
  ProblemDetail forbidden() {
    var problem = ProblemDetail.forStatusAndDetail(HttpStatus.FORBIDDEN, "The API key lacks the required scope.");
    problem.setProperty("code", "INSUFFICIENT_SCOPE");
    return problem;
  }

  @ExceptionHandler(IdempotencyConflictException.class)
  ProblemDetail idempotencyConflict() {
    var problem = ProblemDetail.forStatusAndDetail(HttpStatus.CONFLICT, "The idempotency key was already used with a different request.");
    problem.setProperty("code", "IDEMPOTENCY_CONFLICT");
    return problem;
  }

  @ExceptionHandler(DuplicateReferenceException.class)
  ProblemDetail duplicateReference() {
    var problem = ProblemDetail.forStatusAndDetail(HttpStatus.CONFLICT, "This provider reference has already been submitted for this organization.");
    problem.setProperty("code", "DUPLICATE_REFERENCE");
    return problem;
  }

  public static class IdempotencyConflictException extends RuntimeException {}
  public static class DuplicateReferenceException extends RuntimeException {}
}
