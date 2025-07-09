#include "mcv_platform.h"
#include "comp_render_bloom.h"
#include "render/textures/render_to_texture.h"
#include "resources/resource.h"
#include "render/render_utils.h"
#include "render/blur_step.h"

DECL_OBJ_MANAGER("render_bloom", TCompRenderBloom);

// ---------------------
TCompRenderBloom::TCompRenderBloom() 
  : cte_bloom(CTE_BUFFER_SLOT_BLOOM)
{
  bool is_ok = cte_bloom.create("bloom");
  assert(is_ok);
  // How we mix each downsampled scale
  add_weights = VEC4(3.0f, 1.0, 0.6f, 0.4f);
}

TCompRenderBloom::~TCompRenderBloom() {
  cte_bloom.destroy();
}

void TCompRenderBloom::debugInMenu() {
  TCompRenderBlur::debugInMenu();
  ImGui::DragFloat("Threshold Min", &threshold_min, 0.01f, 0.f, 1.f);
  ImGui::DragFloat("Threshold Max", &threshold_max, 0.01f, 0.f, 2.f);
  ImGui::DragFloat("Multiplier", &multiplier, 0.01f, 0.f, 3.f);
  ImGui::DragFloat4("Add Weights", &add_weights.x, 0.02f, 0.f, 3.f);
  ImGui::DragFloat("Emissive Bloom", &emissive_bloom, 0.02f, 1.f, 4.f);
}

void TCompRenderBloom::load(const json& j, TEntityParseContext& ctx) {
  TCompRenderBlur::load(j, ctx);
  if (j.count("weights"))
    cte_bloom.bloom_weights = loadVEC4(j, "weights");
  
  threshold_min = j.value("threshold_min", threshold_min);
  threshold_max = j.value("threshold_max", threshold_max);
  multiplier = j.value("multiplier", multiplier);

  rt_highlights = new CRenderToTexture();
  char rt_name[64];
  sprintf(rt_name, "BloomFiltered_%08x", CHandle(this).asUnsigned());
  bool is_ok = rt_highlights->createRT(rt_name, Render.width, Render.height, DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_FORMAT_UNKNOWN);
  assert(is_ok);

  tech_filter = Resources.get("bloom_filter.tech")->as<CTechnique>();
  tech_add = Resources.get("bloom_add.tech")->as<CTechnique>();
  tech_add_shines = Resources.get("presentation_ui.tech")->as<CTechnique>(); //it will do fine
  mesh = Resources.get("unit_quad_xy.mesh")->as<CMesh>();
}

void TCompRenderBloom::addBloom() {
  
  if (!enabled || nactive_steps == 0)
    return;

  CGpuScope gpu_scope("CompBloomAddBloom");

  cte_bloom.bloom_weights = add_weights * multiplier;
  cte_bloom.bloom_threshold_min = threshold_min * threshold_max;    // So min is always below max
  cte_bloom.bloom_threshold_max = threshold_max;
  cte_bloom.emissive_bloom_factor = emissive_bloom;

  // Remove weights of unused steps
  if (nactive_steps < 4)
    cte_bloom.bloom_weights.w = 0.f;
  if (nactive_steps < 3)
    cte_bloom.bloom_weights.z = 0.f;
  if (nactive_steps < 2)
    cte_bloom.bloom_weights.y = 0.f;
  
  cte_bloom.updateGPU();
  cte_bloom.activate();

  assert(mesh);
  assert(tech_add);

  // Activate the slots in the range 0..N
  // The slot0 gets the most blurred whites
  int i = nactive_steps - 1;
  int nslot = 0;
  while (nslot < 4 && i >= 0) {
    steps[i]->rt_output->activate( nslot );
    ++nslot;
    --i;
  }

  tech_add->activate();
  mesh->activateAndRender();
}

// ---------------------------------------
void TCompRenderBloom::generateHighlights(CTexture* in_texture) {

  if (!enabled)
    return;

  CGpuScope gpu_scope("CompBloomGenerateHighlights");

  // Filter input image to gather only the highlights
  auto prev_rt = rt_highlights->activateRT();
  assert(prev_rt);

  in_texture->activate(TS_ALBEDO);
  tech_filter->activate();
  mesh->activateAndRender();

  //add to the highlights the shine category
  t_shine->activate(TS_ALBEDO);
  tech_add_shines->activate();
  mesh->activateAndRender();

  // Blur the highlights
  TCompRenderBlur::apply(rt_highlights);

  // Restore the prev rt
  prev_rt->activateRT();
}

void TCompRenderBloom::setShineTexture(CTexture* tex) {
  t_shine = tex;
}