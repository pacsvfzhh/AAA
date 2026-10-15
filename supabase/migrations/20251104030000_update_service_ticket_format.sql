/*
  # Update Service Ticket Number Format

  1. Changes
    - Replace date-based service ticket format with alphanumeric ID format
    - New format: SRV-XXXXX-YYYY where:
      - XXXXX: 5 uppercase letters (A-Z)
      - YYYY: 4 random digits (0-9)
    - Example: SRV-HTKPQ-7392

  2. Security
    - No RLS changes needed
    - Maintains existing unique constraint
*/

-- Update function to generate new format service ticket number
CREATE OR REPLACE FUNCTION generate_service_ticket_number()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  new_ticket text;
  ticket_exists boolean;
  letter_part text;
  digit_part text;
  letters text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  i int;
BEGIN
  LOOP
    -- Generate 5 random uppercase letters
    letter_part := '';
    FOR i IN 1..5 LOOP
      letter_part := letter_part || substr(letters, floor(random() * 26 + 1)::int, 1);
    END LOOP;

    -- Generate 4 random digits
    digit_part := LPAD(FLOOR(RANDOM() * 10000)::text, 4, '0');

    -- Combine into format: SRV-XXXXX-YYYY
    new_ticket := 'SRV-' || letter_part || '-' || digit_part;

    -- Check if this ticket number already exists
    SELECT EXISTS(SELECT 1 FROM customer_service_sessions WHERE service_ticket_number = new_ticket) INTO ticket_exists;

    -- Exit loop if ticket number is unique
    EXIT WHEN NOT ticket_exists;
  END LOOP;

  RETURN new_ticket;
END;
$$;
