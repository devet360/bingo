-- Run this in phpMyAdmin after importing schema.sql.
-- It creates or resets the dashboard's fixed super-admin account (id = 1).
-- Change the temporary password immediately after signing in.

INSERT INTO admin_users (id, username, password_hash)
VALUES (
    1,
    'superadmin',
    '$2y$12$i4cNLi7SZJrgG0BHcEUEC.oXO5p679sB9mkH5eTsITEdpyFH9yBxG'
)
ON DUPLICATE KEY UPDATE
    username = 'superadmin',
    password_hash = '$2y$12$i4cNLi7SZJrgG0BHcEUEC.oXO5p679sB9mkH5eTsITEdpyFH9yBxG';

SELECT id, username, created_at
FROM admin_users
WHERE id = 1;
