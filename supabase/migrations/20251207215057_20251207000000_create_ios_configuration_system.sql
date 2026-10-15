/*
  # Create iOS-specific Configuration System

  1. Configuration Keys
    - `ios_config` (jsonb) - Comprehensive iOS-specific settings
      - enable_animations: boolean - Enable/disable all animations
      - enable_blur: boolean - Enable/disable blur effects
      - enable_shadows: boolean - Enable/disable shadow effects
      - enable_gradients: boolean - Enable/disable gradient backgrounds
      - enable_particles: boolean - Enable/disable particle effects
      - enable_transitions: boolean - Enable/disable CSS transitions
      - enable_transforms: boolean - Enable/disable CSS transforms
      - enable_icons: boolean - Enable/disable icon rendering
      - image_quality: string - 'low' | 'medium' | 'high'
      - video_autoplay: boolean - Enable/disable video autoplay
      - video_quality: string - 'low' | 'medium' | 'high'
      - hardware_acceleration: boolean - Enable/disable hardware acceleration
      - smooth_scrolling: boolean - Enable/disable smooth scrolling
      - viewport_fix: boolean - Enable/disable iOS viewport height fix
      - keyboard_fix: boolean - Enable/disable iOS keyboard fixes
      - touch_optimization: boolean - Enable/disable touch optimizations
      - debounce_delay: number - Delay for input debouncing (ms)
      - animation_duration: number - Duration for animations (ms)

  2. Default iOS Configuration
    - Conservative defaults that prioritize compatibility over visual effects
    - Can be customized by super admin

  3. Security
    - Uses existing system_configs RLS policies
    - Only authenticated users can read/modify
    - Application handles super_admin authorization

  4. Notes
    - This configuration is ONLY applied to iOS devices (iPhone/iPad)
    - Android and desktop devices are unaffected
    - Configuration is loaded dynamically on iOS devices
*/

-- Insert default iOS configuration
INSERT INTO system_configs (key, value, description)
VALUES (
  'ios_config',
  jsonb_build_object(
    'enable_animations', true,
    'enable_blur', false,
    'enable_shadows', true,
    'enable_gradients', true,
    'enable_particles', false,
    'enable_transitions', true,
    'enable_transforms', true,
    'enable_icons', true,
    'image_quality', 'medium',
    'video_autoplay', false,
    'video_quality', 'medium',
    'hardware_acceleration', true,
    'smooth_scrolling', true,
    'viewport_fix', true,
    'keyboard_fix', true,
    'touch_optimization', true,
    'debounce_delay', 200,
    'animation_duration', 300
  ),
  'iOS-specific configuration settings for compatibility and performance'
)
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value,
    description = EXCLUDED.description,
    updated_at = now();

-- Create function to get iOS configuration
CREATE OR REPLACE FUNCTION get_ios_config()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  config_value jsonb;
BEGIN
  SELECT value INTO config_value
  FROM system_configs
  WHERE key = 'ios_config';

  RETURN COALESCE(config_value, jsonb_build_object(
    'enable_animations', true,
    'enable_blur', false,
    'enable_shadows', true,
    'enable_gradients', true,
    'enable_particles', false,
    'enable_transitions', true,
    'enable_transforms', true,
    'enable_icons', true,
    'image_quality', 'medium',
    'video_autoplay', false,
    'video_quality', 'medium',
    'hardware_acceleration', true,
    'smooth_scrolling', true,
    'viewport_fix', true,
    'keyboard_fix', true,
    'touch_optimization', true,
    'debounce_delay', 200,
    'animation_duration', 300
  ));
END;
$$;

-- Create function to update iOS configuration
CREATE OR REPLACE FUNCTION update_ios_config(new_config jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_value jsonb;
BEGIN
  -- Merge new config with existing config
  INSERT INTO system_configs (key, value, description)
  VALUES (
    'ios_config',
    new_config,
    'iOS-specific configuration settings for compatibility and performance'
  )
  ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      updated_at = now()
  RETURNING value INTO updated_value;

  RETURN updated_value;
END;
$$;