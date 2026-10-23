#include "RVO.h"
#include <iostream>
#include <iomanip>
#include <vector>
void show(const char* name, RVO::RVOSimulator& sim, int count, int steps) {
  for (int tick=0; tick<steps; ++tick) sim.doStep();
  std::cout << "{\"name\":\"" << name << "\",\"steps\":" << steps << ",\"agents\":[";
  for(int i=0;i<count;++i) {
    if(i) std::cout << ',';
    auto p=sim.getAgentPosition(i); auto v=sim.getAgentVelocity(i);
    std::cout << "{\"x\":" << p.x() << ",\"y\":" << p.y() << ",\"vx\":" << v.x() << ",\"vy\":" << v.y() << '}';
  }
  std::cout << "]}";
}
int main() {
  std::cout << std::setprecision(12) << "{\"upstream\":\"c96a6ec8328492bae0721e59774026a119a60b4a\",\"cases\":[";
  RVO::RVOSimulator pair(.1f,5.f,64,2.2f,2.f,.23f,1.1f);
  pair.addAgent(RVO::Vector2(-3.f,0.f)); pair.addAgent(RVO::Vector2(3.f,0.f));
  pair.setAgentPrefVelocity(0,RVO::Vector2(1.f,.015f)); pair.setAgentPrefVelocity(1,RVO::Vector2(-1.f,-.015f));
  show("pair",pair,2,10);
  std::cout << ',';
  RVO::RVOSimulator wall(.1f,5.f,64,2.2f,2.f,.23f,1.2f);
  wall.addObstacle({RVO::Vector2(3,-3),RVO::Vector2(3.5,-3),RVO::Vector2(3.5,3),RVO::Vector2(3,3)});
  wall.processObstacles(); wall.addAgent(RVO::Vector2(0,0)); wall.setAgentPrefVelocity(0,RVO::Vector2(1.2,0));
  show("wall",wall,1,50);
  std::cout << ',';
  RVO::RVOSimulator corner(.1f,5.f,64,2.2f,2.f,.23f,1.2f);
  corner.addObstacle({RVO::Vector2(0,0),RVO::Vector2(3,0),RVO::Vector2(3,1),RVO::Vector2(1,1),RVO::Vector2(1,3),RVO::Vector2(0,3)});
  corner.processObstacles(); corner.addAgent(RVO::Vector2(-2,1.5)); corner.setAgentPrefVelocity(0,RVO::Vector2(1,.1));
  show("corner",corner,1,25);
  std::cout << "]}";
}
