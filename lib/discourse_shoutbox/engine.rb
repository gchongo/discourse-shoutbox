# frozen_string_literal: true

module ::DiscourseShoutbox
  class Engine < ::Rails::Engine
    engine_name PLUGIN_NAME
    isolate_namespace DiscourseShoutbox
  end
end
